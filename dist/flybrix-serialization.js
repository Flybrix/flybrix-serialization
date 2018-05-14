(function () {
    'use strict';

    angular.module('flybrixSerialization', []).factory('fbSerializer', function () {
        return {
            Serializer: FlybrixSerialization.Serializer,
            createHandler: FlybrixSerialization.parse,
        };
    });
});

(function (global) {
    'use strict';

    var nullMask = function () {
        return null;
    };

    var nullMaskArray = function () {
        return [];
    };

    var defaultIsNull = function (val) {
        return val === null || val === undefined;
    };

    function Handler(descriptor, byteCount, empty, encode, decode, fullMask, maskArray, isNull) {
        this.descriptor = descriptor;
        this.byteCount = byteCount;
        this.encode = encode;
        this.decode = decode;
        this.empty = empty;
        this.fullMask = fullMask || nullMask;
        this.maskArray = maskArray || nullMaskArray;
        this.isNull = isNull || defaultIsNull;
    }

    var handlers = {};

    var hasBit = function (mask, idx) {
        return (mask[Math.floor(idx / 8)] & (1 << (idx % 8))) !== 0;
    };

    var emptyNumeric = function () {
        return 0;
    };

    var zeroArray = function (l) {
        var result = [];
        for (var idx = 0; idx < l; ++idx) {
            result.push(0);
        }
        return result;
    };

    var createNumericType = function (keyShort, key, byteCount) {
        var encode = function (serializer, data) {
            serializer.dataView['set' + key](serializer.index, data, 1);
            serializer.add(byteCount);
        };

        var decode = function (serializer) {
            var data = serializer.dataView['get' + key](serializer.index, 1);
            serializer.add(byteCount);
            return data;
        };

        var handler = new Handler(keyShort, byteCount, emptyNumeric, encode, decode);

        handler.isBasic = true;

        return handler;
    };

    handlers.u8 = createNumericType('u8', 'Uint8', 1);
    handlers.u16 = createNumericType('u16', 'Uint16', 2);
    handlers.u32 = createNumericType('u32', 'Uint32', 4);
    handlers.i8 = createNumericType('i8', 'Int8', 1);
    handlers.i16 = createNumericType('i16', 'Int16', 2);
    handlers.i32 = createNumericType('i32', 'Int32', 4);
    handlers.f32 = createNumericType('f32', 'Float32', 4);
    handlers.f64 = createNumericType('f64', 'Float64', 8);

    handlers.bool = new Handler(
        'bool',
        handlers.u8.byteCount,
        function () {
            return false;
        },
        function (serializer, data) {
            handlers.u8.encode(serializer, data ? 1 : 0);
        },
        function (serializer) {
            return handlers.u8.decode(serializer) !== 0;
        });
    handlers.bool.isBasic = true;

    handlers.void = new Handler(
        'void',
        0,
        function () {
            return true;
        },
        function (serializer, data) {
        },
        function () {
            return true;
        },
        null,
        null,
        function (val) {
            return !val;
        });
    handlers.void.isBasic = true;

    var asciiEncode = function (name, length) {
        var response = new Uint8Array(length);
        name.split('').forEach(function (c, idx) {
            response[idx] = c.charCodeAt(0);
        });
        response[length - 1] = 0;
        return response;
    };

    var asciiDecode = function (name, length) {
        var response = '';
        var l = Math.min(name.length, length - 1);
        for (var i = 0; i < l; ++i) {
            if (name[i] === 0) {
                return response;
            }
            response += String.fromCharCode(name[i]);
        }
        return response;
    };

    handlers.string = function (length) {
        var handler = handlers.arrayUnmasked(length, handlers.u8);
        var encode = function (serializer, data) {
            handler.encode(serializer, asciiEncode(data, length));
        };
        var decode = function (serializer) {
            return asciiDecode(handler.decode(serializer), length);
        };
        var empty = function () {
            return '';
        };
        return new Handler('s' + length, length, empty, encode, decode);
    };

    handlers.s = new Handler(
        's',
        0,
        function () {
            return '';
        },
        function (serializer, data) {
            var byteCount = Math.min(data.length, serializer.dataView.byteLength - serializer.index);
            for (var idx = 0; idx < byteCount; ++idx) {
                handlers.u8.encode(serializer, data.charCodeAt(idx));
            }
            if (serializer.index < serializer.dataView.byteLength) {
                handlers.u8.encode(serializer, 0);
            }
        },
        function (serializer) {
            var response = '';
            var byteCount = serializer.dataView.byteLength - serializer.index;
            while (byteCount-- > 0) {
                var charCode = handlers.u8.decode(serializer);
                if (!charCode) {
                    return response;
                }
                response += String.fromCharCode(charCode);
            }
            return response;
        });
    handlers.s.isBasic = true;

    handlers.arrayUnmasked = function (length, handler) {
        var children = [];
        for (var idx = 0; idx < length; ++idx) {
            children.push(handler);
        }
        var result = handlers.tupleUnmasked(children);
        result.descriptor = '[' + handler.descriptor + ':' + length + ']';
        return result;
    };

    handlers.tupleUnmasked = function (children) {
        var encode = function (serializer, data, masks) {
            if (masks === true) {
                masks = null;
            }
            children.forEach(function (child, idx) {
                child.encode(serializer, data[idx], masks && masks[idx]);
            });
        };
        var decode = function (serializer) {
            return children.map(function (child) {
                return child.decode(serializer);
            });
        };
        var empty = function () {
            return children.map(function (child) {
                return child.empty();
            });
        };
        var fullMask = function () {
            var nonNullChild = false;
            var result = {};
            children.forEach(function (child, idx) {
                var value = child.fullMask();
                if (value !== null) {
                    nonNullChild = true;
                    result[idx] = value;
                }
            });
            if (!nonNullChild) {
                return null;
            }
            return result;
        };
        var byteCount = children.reduce(function (accum, child) {
            return accum + child.byteCount;
        }, 0);
        var childDescriptors = children.map(function (child) {
            return child.descriptor;
        });
        var descriptor = '(' + childDescriptors.join(',') + ')';
        return new Handler(descriptor, byteCount, empty, encode, decode, fullMask);
    };

    handlers.arrayMasked = function (length, handler, maskBitCount) {
        var children = [];
        for (var idx = 0; idx < length; ++idx) {
            children.push(handler);
        }
        var result = handlers.tupleMasked(children, maskBitCount);
        var maskSize = (result.byteCount - (length * handler.byteCount)) * 8;
        result.descriptor = '[/' + maskSize + '/' + handler.descriptor + ':' + length + ']';
        return result;
    };

    handlers.tupleMasked = function (children, maskBitCount) {
        var maskBytes = Math.ceil(children.length / 8);
        if (maskBitCount) {
            maskBytes = Math.max(maskBytes, Math.ceil(maskBitCount / 8));
        }
        var maskHandler = handlers.arrayUnmasked(maskBytes, handlers.u8);
        var maskArray = function (data, masks) {
            if (masks === true) {
                masks = null;
            }
            var mask = zeroArray(maskBytes);
            var extraMask = null;
            if (masks && ('MASK' in masks)) {
                extraMask = masks.MASK;
            }
            children.forEach(function (child, idx) {
                var value = data[idx];
                if (extraMask && !extraMask[idx]) {
                    return;
                }
                if (!child.isNull(value)) {
                    mask[Math.floor(idx / 8)] |= 1 << (idx % 8);
                }
            });

            return mask;
        };
        var encode = function (serializer, data, masks) {
            var mask = maskArray(data, masks);

            maskHandler.encode(serializer, mask);
            children.forEach(function (child, idx) {
                if (hasBit(mask, idx)) {
                    child.encode(serializer, data[idx], masks && masks[idx]);
                }
            });
        };
        var decode = function (serializer) {
            var mask = maskHandler.decode(serializer);
            return children.map(function (child, idx) {
                if (hasBit(mask, idx)) {
                    return child.decode(serializer);
                }
                return null;
            });
        };
        var empty = function () {
            return children.map(function (child) {
                return child.empty();
            });
        };
        var fullMask = function () {
            var result = {};
            children.forEach(function (child, idx) {
                var value = child.fullMask();
                if (value !== null) {
                    result[idx] = value;
                }
            });
            result.MASK = children.map(function () {
                return true;
            });
            return result;
        };
        var byteCount = children.reduce(function (accum, child) {
            return accum + child.byteCount;
        }, maskBytes);
        var childDescriptors = children.map(function (child) {
            return child.descriptor;
        });
        var descriptor = '(/' + (maskBytes * 8) + '/' + childDescriptors.join(',') + ')';
        return new Handler(descriptor, byteCount, empty, encode, decode, fullMask, maskArray);
    };

    handlers.mapUnmasked = function (children) {
        var encode = function (serializer, data, masks) {
            if (masks === true) {
                masks = null;
            }
            children.forEach(function (child) {
                child.handler.encode(serializer, data[child.key], masks && masks[child.key]);
            });
        };
        var decode = function (serializer) {
            var result = {};
            children.forEach(function (child) {
                result[child.key] = child.handler.decode(serializer);
            });
            return result;
        };
        var empty = function () {
            var result = {};
            children.forEach(function (child) {
                result[child.key] = child.handler.empty();
            });
            return result;
        };
        var fullMask = function () {
            var nonNullChild = false;
            var result = {};
            children.forEach(function (child) {
                var value = child.handler.fullMask();
                if (value !== null) {
                    nonNullChild = true;
                    result[child.key] = value;
                }
            });
            if (!nonNullChild) {
                return null;
            }
            return result;
        };
        var byteCount = children.reduce(function (accum, child) {
            return accum + child.handler.byteCount;
        }, 0);
        var childDescriptors = children.map(function (child) {
            return child.key + ':' + child.handler.descriptor;
        });
        var descriptor = '{' + childDescriptors.join(',') + '}';
        return new Handler(descriptor, byteCount, empty, encode, decode, fullMask);
    };

    handlers.mapMasked = function (children, maskBitCount) {
        var maskBytes = Math.ceil(children.length / 8);
        if (maskBitCount) {
            maskBytes = Math.max(maskBytes, Math.ceil(maskBitCount / 8));
        }
        var maskHandler = handlers.arrayUnmasked(maskBytes, handlers.u8);
        var maskArray = function (data, masks) {
            if (masks === true) {
                masks = null;
            }
            var mask = zeroArray(maskBytes);
            var extraMask = null;
            if (masks && ('MASK' in masks)) {
                extraMask = masks.MASK;
            }

            children.forEach(function (child, idx) {
                var value = data[child.key];
                if (extraMask && !extraMask[child.key]) {
                    return;
                }
                if (!child.handler.isNull(value)) {
                    mask[Math.floor(idx / 8)] |= 1 << (idx % 8);
                }
            });

            return mask;
        };
        var encode = function (serializer, data, masks) {
            var mask = maskArray(data, masks);

            maskHandler.encode(serializer, mask);
            children.forEach(function (child, idx) {
                if (hasBit(mask, idx)) {
                    child.handler.encode(serializer, data[child.key], masks && masks[child.key]);
                }
            });
        };
        var decode = function (serializer) {
            var mask = maskHandler.decode(serializer);
            var result = {};
            children.forEach(function (child, idx) {
                if (hasBit(mask, idx)) {
                    result[child.key] = child.handler.decode(serializer);
                }
            });
            return result;
        };
        var empty = function () {
            var result = {};
            children.forEach(function (child) {
                result[child.key] = child.handler.empty();
            });
            return result;
        };
        var fullMask = function () {
            var result = {};
            var mask = {};
            children.forEach(function (child) {
                var value = child.handler.fullMask();
                if (value !== null) {
                    result[child.key] = value;
                }
                mask[child.key] = true;
            });
            result.MASK = mask;
            return result;
        };
        var byteCount = children.reduce(function (accum, child) {
            return accum + child.handler.byteCount;
        }, maskBytes);
        var childDescriptors = children.map(function (child) {
            return child.key + ':' + child.handler.descriptor;
        });
        var descriptor = '{/' + (maskBytes * 8) + '/' + childDescriptors.join(',') + '}';
        return new Handler(descriptor, byteCount, empty, encode, decode, fullMask, maskArray);
    };

    if (!global.FlybrixSerialization) {
        global.FlybrixSerialization = {};
    }
    global.FlybrixSerialization._handlers = handlers;

}(this));

(function (global) {
    'use strict';

    function StringToken(position, value) {
        this.position = position;
        this.value = value;
    }

    var numericTest = /^\d+$/;
    var nameTest = /^\w+$/;

    var TokenCategories = {
        SYMBOL: 0,
        NUMBER: 1,
        NAME: 2,
    };

    function Token(stringToken) {
        this.position = stringToken.position;
        this.value = stringToken.value;
        if (numericTest.test(this.value)) {
            this.category = TokenCategories.NUMBER;
            this.value = parseInt(this.value);
        } else if (nameTest.test(this.value)) {
            this.category = TokenCategories.NAME;
        } else {
            this.category = TokenCategories.SYMBOL;
        }
    }

    var validCharSetTest = /^[{}\[\]()\/=:,;\w\s]*$/;

    var isValid = function (text) {
        return validCharSetTest.test(text);
    };

    var tokenizer = function (text) {
        if (!isValid(text)) {
            throw new Error('Passed config contains invalid characters');
        }
        var re = /([{}\[\]()\/=:,;]|\w+)/g;
        var match;
        var matches = [];
        while ((match = re.exec(text)) !== null) {
            matches.push(new StringToken(match.index, match[0]));
        }
        return matches;
    };

    var lexer = function (tokens) {
        return tokens.map(function (token) {
            return new Token(token);
        });
    };

    var TypeCategories = {
        NAMED: 0,
        MAP_UNMASKED: 2,
        MAP_MASKED: 3,
        TUPLE_UNMASKED: 4,
        TUPLE_MASKED: 5,
        ARRAY_UNMASKED: 6,
        ARRAY_MASKED: 7,
    };

    function Type(category, properties, mask) {
        this.category = category;
        this.properties = properties;
        this.mask = mask || 0;
    }

    Type.prototype.generateHandler = function (library) {
        var handlers = global.FlybrixSerialization._handlers;
        var props = this.properties;
        var mask = this.mask;
        var handler = null;
        var children;
        switch (this.category) {
            case TypeCategories.NAMED:
                if (props in handlers) {
                    handler = handlers[props];
                    if (!handler.isBasic) {
                        handler = null;
                    }
                } else if (props[0] === 's') {
                    var length = props.substring(1);
                    if (numericTest.test(length)) {
                        handler = handlers.string(parseInt(length));
                    }
                } else if (props in library) {
                    handler = library[props];
                }
                if (!handler) {
                    throw {
                        position: -1,
                        error: 'Unrecognized type "' + props + '"',
                    };
                }
                return handler;
            case TypeCategories.MAP_UNMASKED:
                children = props.map(function (child) {
                    return {
                        key: child.name,
                        handler: child.value.generateHandler(library),
                    };
                });
                return handlers.mapUnmasked(children);
            case TypeCategories.MAP_MASKED:
                children = props.map(function (child) {
                    return {
                        key: child.name,
                        handler: child.value.generateHandler(library),
                    };
                });
                return handlers.mapMasked(children, mask);
            case TypeCategories.TUPLE_UNMASKED:
                children = props.map(function (child) {
                    return child.generateHandler(library);
                });
                return handlers.tupleUnmasked(children);
            case TypeCategories.TUPLE_MASKED:
                children = props.map(function (child) {
                    return child.generateHandler(library);
                });
                return handlers.tupleMasked(children, mask);
            case TypeCategories.ARRAY_UNMASKED:
                return handlers.arrayUnmasked(props.count, props.value.generateHandler(library));
            case TypeCategories.ARRAY_MASKED:
                return handlers.arrayMasked(props.count, props.value.generateHandler(library), mask);
            default:
                throw {
                    position: -1,
                    error: 'Unrecognized type category',
                };
        }
    };

    var readToken = function (serializer) {
        var token = serializer.dataView[serializer.index];
        serializer.add(1);
        if (!token) {
            throw {
                position: -1,
                error: 'Unexpected end of string',
            };
        }
        return token;
    };

    var nameParser = function (serializer) {
        var token = readToken(serializer);
        if (token.category !== TokenCategories.NAME) {
            throw {
                position: token.position,
                error: 'Expected name, got: "' + token.value + '"',
            };
        }
        if (token.value === 'MASK') {
            throw {
                position: token.position,
                error: 'Disallowed name "MASK" given',
            };
        }
        return token.value;
    };

    var numberParser = function (serializer) {
        var token = readToken(serializer);
        if (token.category !== TokenCategories.NUMBER) {
            throw {
                position: token.position,
                error: 'Expected number, got: "' + token.value + '"',
            };
        }
        return token.value;
    };

    var consumeSymbol = function (serializer, symbol) {
        var token = readToken(serializer);
        if (token.value !== symbol) {
            throw {
                position: token.position,
                error: 'Expected "' + symbol + '", got: "' + token.value + '"',
            };
        }
    };

    var maskParser = function (serializer) {
        // "//" or "/<NUMBER>/", otherwise there is no mask
        // Labeled with <MASK> in comments below
        var token = readToken(serializer);
        if (token.value !== '/') {
            serializer.add(-1);
            return {
                masked: false,
            };
        }
        token = readToken(serializer);
        if (token.value === '/') {
            return {
                masked: true,
                defined: false,
            };
        }
        if (token.category !== TokenCategories.NUMBER) {
            throw {
                position: token.position,
                error: 'Expected "/" or number',
            };
        }
        var value = token.value;
        token = readToken(serializer);
        if (token.value !== '/') {
            throw {
                position: token.position,
                error: 'Expected "/"',
            };
        }
        return {
            masked: true,
            defined: true,
            value: value,
        };
    };

    var typeMapParser = function (serializer) {
        // {<MASK> <NAME>:<TYPE>, <NAME>:<TYPE>, <NAME>:<TYPE>}
        var mask = maskParser(serializer);
        var children = [];
        while (true) {
            var name = nameParser(serializer);
            consumeSymbol(serializer, ':');
            var value = typeParser(serializer);
            children.push({
                name: name,
                value: value,
            });
            var token = readToken(serializer);
            if (token.value === '}') {
                if (mask.masked) {
                    if (mask.defined) {
                        return new Type(TypeCategories.MAP_MASKED, children, mask.value);
                    } else {
                        return new Type(TypeCategories.MAP_MASKED, children);
                    }
                } else {
                    return new Type(TypeCategories.MAP_UNMASKED, children);
                }
            }
            if (token.value !== ',') {
                throw {
                    position: token.position,
                    error: 'Unexpected token after map element: "' + token.value + '"',
                };
            }
        }
    };

    var typeTupleParser = function (serializer) {
        // (<MASK> <TYPE>, <TYPE>, <TYPE>)
        var mask = maskParser(serializer);
        var children = [];
        while (true) {
            children.push(typeParser(serializer));
            var token = readToken(serializer);
            if (token.value === ')') {
                if (mask.masked) {
                    if (mask.defined) {
                        return new Type(TypeCategories.TUPLE_MASKED, children, mask.value);
                    } else {
                        return new Type(TypeCategories.TUPLE_MASKED, children);
                    }
                } else {
                    return new Type(TypeCategories.TUPLE_UNMASKED, children);
                }
            }
            if (token.value !== ',') {
                throw {
                    position: token.position,
                    error: 'Unexpected token after tuple element: "' + token.value + '"',
                };
            }
        }
    };

    var typeArrayParser = function (serializer) {
        // [<MASK> <TYPE>:<NUMBER>]
        var mask = maskParser(serializer);
        var value = typeParser(serializer);
        consumeSymbol(serializer, ':');
        var count = numberParser(serializer);
        consumeSymbol(serializer, ']');
        var children = {
            value: value,
            count: count,
        };
        if (mask.masked) {
            if (mask.defined) {
                return new Type(TypeCategories.ARRAY_MASKED, children, mask.value);
            } else {
                return new Type(TypeCategories.ARRAY_MASKED, children);
            }
        } else {
            return new Type(TypeCategories.ARRAY_UNMASKED, children);
        }
    };

    var typeParser = function (serializer) {
        // Options:
        // - <NAME>
        // - Tuple
        // - Array
        // - Map
        var token = readToken(serializer);
        if (!token) {
            throw {
                position: -1,
                error: 'Unexpected end of string',
            };
        }
        if (token.category === TokenCategories.NUMBER) {
            throw {
                position: token.position,
                error: 'Unexpected number, type expected',
            };
        }
        if (token.category === TokenCategories.NAME) {
            return new Type(TypeCategories.NAMED, token.value);
        }
        if (token.value === '{') {
            return typeMapParser(serializer);
        }
        if (token.value === '[') {
            return typeArrayParser(serializer);
        }
        if (token.value === '(') {
            return typeTupleParser(serializer);
        }
        throw {
            position: token.position,
            error: 'Unexpected token when describing type: "' + token.value + '"',
        };
    };

    var parser = function (tokens, source) {
        var serializer = new global.FlybrixSerialization.Serializer(tokens);
        var structures = [];
        while (serializer.index < serializer.dataView.length) {
            var name = nameParser(serializer);
            if (name[0] !== name[0].toUpperCase()) {
                throw {
                    position: -1,
                    error: 'Structure names cannot start with lowercase letters',
                };
            }
            consumeSymbol(serializer, '=');
            var value = typeParser(serializer);
            consumeSymbol(serializer, ';');
            structures.push({
                name: name,
                value: value,
            });
        }
        return structures;
    };

    var createHandlers = function (structure) {
        var library = {};
        structure.forEach(function (entry) {
            library[entry.name] = entry.value.generateHandler(library);
        });
        return library;
    };

    var parse = function (text) {
        try {
            return createHandlers(parser(lexer(tokenizer(text), text), text));
        } catch (err) {
            throw new Error(err.error);
        }
    };

    if (!global.FlybrixSerialization) {
        global.FlybrixSerialization = {};
    }

    global.FlybrixSerialization._parserSteps = {
        tokenizer: tokenizer,
        lexer: lexer,
        parser: parser,
        TokenCategories: TokenCategories,
        TypeCategories: TypeCategories,
        StringToken: StringToken,
        Token: Token,
        Type: Type,
    };

    global.FlybrixSerialization.parse = parse;

}(this));

(function (global) {
    'use strict';

    function Serializer(dataView) {
        this.index = 0;
        this.dataView = dataView;
    }

    Serializer.prototype.add = function (increment) {
        this.index += increment;
    };

    if (!global.FlybrixSerialization) {
        global.FlybrixSerialization = {};
    }
    global.FlybrixSerialization.Serializer = Serializer;

}(this));

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1vZHVsZS5qcyIsImhhbmRsZXJzLmpzIiwicGFyc2VyLmpzIiwic2VyaWFsaXplci5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FDVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQ3ZiQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FDaFpBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImZseWJyaXgtc2VyaWFsaXphdGlvbi5qcyIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiAoKSB7XHJcbiAgICAndXNlIHN0cmljdCc7XHJcblxyXG4gICAgYW5ndWxhci5tb2R1bGUoJ2ZseWJyaXhTZXJpYWxpemF0aW9uJywgW10pLmZhY3RvcnkoJ2ZiU2VyaWFsaXplcicsIGZ1bmN0aW9uICgpIHtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBTZXJpYWxpemVyOiBGbHlicml4U2VyaWFsaXphdGlvbi5TZXJpYWxpemVyLFxyXG4gICAgICAgICAgICBjcmVhdGVIYW5kbGVyOiBGbHlicml4U2VyaWFsaXphdGlvbi5wYXJzZSxcclxuICAgICAgICB9O1xyXG4gICAgfSk7XHJcbn0pO1xyXG4iLCIoZnVuY3Rpb24gKGdsb2JhbCkge1xyXG4gICAgJ3VzZSBzdHJpY3QnO1xyXG5cclxuICAgIHZhciBudWxsTWFzayA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIG51bGxNYXNrQXJyYXkgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgcmV0dXJuIFtdO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgZGVmYXVsdElzTnVsbCA9IGZ1bmN0aW9uICh2YWwpIHtcclxuICAgICAgICByZXR1cm4gdmFsID09PSBudWxsIHx8IHZhbCA9PT0gdW5kZWZpbmVkO1xyXG4gICAgfTtcclxuXHJcbiAgICBmdW5jdGlvbiBIYW5kbGVyKGRlc2NyaXB0b3IsIGJ5dGVDb3VudCwgZW1wdHksIGVuY29kZSwgZGVjb2RlLCBmdWxsTWFzaywgbWFza0FycmF5LCBpc051bGwpIHtcclxuICAgICAgICB0aGlzLmRlc2NyaXB0b3IgPSBkZXNjcmlwdG9yO1xyXG4gICAgICAgIHRoaXMuYnl0ZUNvdW50ID0gYnl0ZUNvdW50O1xyXG4gICAgICAgIHRoaXMuZW5jb2RlID0gZW5jb2RlO1xyXG4gICAgICAgIHRoaXMuZGVjb2RlID0gZGVjb2RlO1xyXG4gICAgICAgIHRoaXMuZW1wdHkgPSBlbXB0eTtcclxuICAgICAgICB0aGlzLmZ1bGxNYXNrID0gZnVsbE1hc2sgfHwgbnVsbE1hc2s7XHJcbiAgICAgICAgdGhpcy5tYXNrQXJyYXkgPSBtYXNrQXJyYXkgfHwgbnVsbE1hc2tBcnJheTtcclxuICAgICAgICB0aGlzLmlzTnVsbCA9IGlzTnVsbCB8fCBkZWZhdWx0SXNOdWxsO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBoYW5kbGVycyA9IHt9O1xyXG5cclxuICAgIHZhciBoYXNCaXQgPSBmdW5jdGlvbiAobWFzaywgaWR4KSB7XHJcbiAgICAgICAgcmV0dXJuIChtYXNrW01hdGguZmxvb3IoaWR4IC8gOCldICYgKDEgPDwgKGlkeCAlIDgpKSkgIT09IDA7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBlbXB0eU51bWVyaWMgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgcmV0dXJuIDA7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciB6ZXJvQXJyYXkgPSBmdW5jdGlvbiAobCkge1xyXG4gICAgICAgIHZhciByZXN1bHQgPSBbXTtcclxuICAgICAgICBmb3IgKHZhciBpZHggPSAwOyBpZHggPCBsOyArK2lkeCkge1xyXG4gICAgICAgICAgICByZXN1bHQucHVzaCgwKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIGNyZWF0ZU51bWVyaWNUeXBlID0gZnVuY3Rpb24gKGtleVNob3J0LCBrZXksIGJ5dGVDb3VudCkge1xyXG4gICAgICAgIHZhciBlbmNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplciwgZGF0YSkge1xyXG4gICAgICAgICAgICBzZXJpYWxpemVyLmRhdGFWaWV3WydzZXQnICsga2V5XShzZXJpYWxpemVyLmluZGV4LCBkYXRhLCAxKTtcclxuICAgICAgICAgICAgc2VyaWFsaXplci5hZGQoYnl0ZUNvdW50KTtcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICB2YXIgZGVjb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAgICAgdmFyIGRhdGEgPSBzZXJpYWxpemVyLmRhdGFWaWV3WydnZXQnICsga2V5XShzZXJpYWxpemVyLmluZGV4LCAxKTtcclxuICAgICAgICAgICAgc2VyaWFsaXplci5hZGQoYnl0ZUNvdW50KTtcclxuICAgICAgICAgICAgcmV0dXJuIGRhdGE7XHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgdmFyIGhhbmRsZXIgPSBuZXcgSGFuZGxlcihrZXlTaG9ydCwgYnl0ZUNvdW50LCBlbXB0eU51bWVyaWMsIGVuY29kZSwgZGVjb2RlKTtcclxuXHJcbiAgICAgICAgaGFuZGxlci5pc0Jhc2ljID0gdHJ1ZTtcclxuXHJcbiAgICAgICAgcmV0dXJuIGhhbmRsZXI7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLnU4ID0gY3JlYXRlTnVtZXJpY1R5cGUoJ3U4JywgJ1VpbnQ4JywgMSk7XHJcbiAgICBoYW5kbGVycy51MTYgPSBjcmVhdGVOdW1lcmljVHlwZSgndTE2JywgJ1VpbnQxNicsIDIpO1xyXG4gICAgaGFuZGxlcnMudTMyID0gY3JlYXRlTnVtZXJpY1R5cGUoJ3UzMicsICdVaW50MzInLCA0KTtcclxuICAgIGhhbmRsZXJzLmk4ID0gY3JlYXRlTnVtZXJpY1R5cGUoJ2k4JywgJ0ludDgnLCAxKTtcclxuICAgIGhhbmRsZXJzLmkxNiA9IGNyZWF0ZU51bWVyaWNUeXBlKCdpMTYnLCAnSW50MTYnLCAyKTtcclxuICAgIGhhbmRsZXJzLmkzMiA9IGNyZWF0ZU51bWVyaWNUeXBlKCdpMzInLCAnSW50MzInLCA0KTtcclxuICAgIGhhbmRsZXJzLmYzMiA9IGNyZWF0ZU51bWVyaWNUeXBlKCdmMzInLCAnRmxvYXQzMicsIDQpO1xyXG4gICAgaGFuZGxlcnMuZjY0ID0gY3JlYXRlTnVtZXJpY1R5cGUoJ2Y2NCcsICdGbG9hdDY0JywgOCk7XHJcblxyXG4gICAgaGFuZGxlcnMuYm9vbCA9IG5ldyBIYW5kbGVyKFxyXG4gICAgICAgICdib29sJyxcclxuICAgICAgICBoYW5kbGVycy51OC5ieXRlQ291bnQsXHJcbiAgICAgICAgZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgfSxcclxuICAgICAgICBmdW5jdGlvbiAoc2VyaWFsaXplciwgZGF0YSkge1xyXG4gICAgICAgICAgICBoYW5kbGVycy51OC5lbmNvZGUoc2VyaWFsaXplciwgZGF0YSA/IDEgOiAwKTtcclxuICAgICAgICB9LFxyXG4gICAgICAgIGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBoYW5kbGVycy51OC5kZWNvZGUoc2VyaWFsaXplcikgIT09IDA7XHJcbiAgICAgICAgfSk7XHJcbiAgICBoYW5kbGVycy5ib29sLmlzQmFzaWMgPSB0cnVlO1xyXG5cclxuICAgIGhhbmRsZXJzLnZvaWQgPSBuZXcgSGFuZGxlcihcclxuICAgICAgICAndm9pZCcsXHJcbiAgICAgICAgMCxcclxuICAgICAgICBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgIH0sXHJcbiAgICAgICAgZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEpIHtcclxuICAgICAgICB9LFxyXG4gICAgICAgIGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgfSxcclxuICAgICAgICBudWxsLFxyXG4gICAgICAgIG51bGwsXHJcbiAgICAgICAgZnVuY3Rpb24gKHZhbCkge1xyXG4gICAgICAgICAgICByZXR1cm4gIXZhbDtcclxuICAgICAgICB9KTtcclxuICAgIGhhbmRsZXJzLnZvaWQuaXNCYXNpYyA9IHRydWU7XHJcblxyXG4gICAgdmFyIGFzY2lpRW5jb2RlID0gZnVuY3Rpb24gKG5hbWUsIGxlbmd0aCkge1xyXG4gICAgICAgIHZhciByZXNwb25zZSA9IG5ldyBVaW50OEFycmF5KGxlbmd0aCk7XHJcbiAgICAgICAgbmFtZS5zcGxpdCgnJykuZm9yRWFjaChmdW5jdGlvbiAoYywgaWR4KSB7XHJcbiAgICAgICAgICAgIHJlc3BvbnNlW2lkeF0gPSBjLmNoYXJDb2RlQXQoMCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmVzcG9uc2VbbGVuZ3RoIC0gMV0gPSAwO1xyXG4gICAgICAgIHJldHVybiByZXNwb25zZTtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIGFzY2lpRGVjb2RlID0gZnVuY3Rpb24gKG5hbWUsIGxlbmd0aCkge1xyXG4gICAgICAgIHZhciByZXNwb25zZSA9ICcnO1xyXG4gICAgICAgIHZhciBsID0gTWF0aC5taW4obmFtZS5sZW5ndGgsIGxlbmd0aCAtIDEpO1xyXG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbDsgKytpKSB7XHJcbiAgICAgICAgICAgIGlmIChuYW1lW2ldID09PSAwKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVzcG9uc2UgKz0gU3RyaW5nLmZyb21DaGFyQ29kZShuYW1lW2ldKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xyXG4gICAgfTtcclxuXHJcbiAgICBoYW5kbGVycy5zdHJpbmcgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XHJcbiAgICAgICAgdmFyIGhhbmRsZXIgPSBoYW5kbGVycy5hcnJheVVubWFza2VkKGxlbmd0aCwgaGFuZGxlcnMudTgpO1xyXG4gICAgICAgIHZhciBlbmNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplciwgZGF0YSkge1xyXG4gICAgICAgICAgICBoYW5kbGVyLmVuY29kZShzZXJpYWxpemVyLCBhc2NpaUVuY29kZShkYXRhLCBsZW5ndGgpKTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBkZWNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgICAgICByZXR1cm4gYXNjaWlEZWNvZGUoaGFuZGxlci5kZWNvZGUoc2VyaWFsaXplciksIGxlbmd0aCk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZW1wdHkgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiAnJztcclxuICAgICAgICB9O1xyXG4gICAgICAgIHJldHVybiBuZXcgSGFuZGxlcigncycgKyBsZW5ndGgsIGxlbmd0aCwgZW1wdHksIGVuY29kZSwgZGVjb2RlKTtcclxuICAgIH07XHJcblxyXG4gICAgaGFuZGxlcnMucyA9IG5ldyBIYW5kbGVyKFxyXG4gICAgICAgICdzJyxcclxuICAgICAgICAwLFxyXG4gICAgICAgIGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgcmV0dXJuICcnO1xyXG4gICAgICAgIH0sXHJcbiAgICAgICAgZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEpIHtcclxuICAgICAgICAgICAgdmFyIGJ5dGVDb3VudCA9IE1hdGgubWluKGRhdGEubGVuZ3RoLCBzZXJpYWxpemVyLmRhdGFWaWV3LmJ5dGVMZW5ndGggLSBzZXJpYWxpemVyLmluZGV4KTtcclxuICAgICAgICAgICAgZm9yICh2YXIgaWR4ID0gMDsgaWR4IDwgYnl0ZUNvdW50OyArK2lkeCkge1xyXG4gICAgICAgICAgICAgICAgaGFuZGxlcnMudTguZW5jb2RlKHNlcmlhbGl6ZXIsIGRhdGEuY2hhckNvZGVBdChpZHgpKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoc2VyaWFsaXplci5pbmRleCA8IHNlcmlhbGl6ZXIuZGF0YVZpZXcuYnl0ZUxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgaGFuZGxlcnMudTguZW5jb2RlKHNlcmlhbGl6ZXIsIDApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSxcclxuICAgICAgICBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgICAgICB2YXIgcmVzcG9uc2UgPSAnJztcclxuICAgICAgICAgICAgdmFyIGJ5dGVDb3VudCA9IHNlcmlhbGl6ZXIuZGF0YVZpZXcuYnl0ZUxlbmd0aCAtIHNlcmlhbGl6ZXIuaW5kZXg7XHJcbiAgICAgICAgICAgIHdoaWxlIChieXRlQ291bnQtLSA+IDApIHtcclxuICAgICAgICAgICAgICAgIHZhciBjaGFyQ29kZSA9IGhhbmRsZXJzLnU4LmRlY29kZShzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgICAgIGlmICghY2hhckNvZGUpIHtcclxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXNwb25zZSArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGNoYXJDb2RlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XHJcbiAgICAgICAgfSk7XHJcbiAgICBoYW5kbGVycy5zLmlzQmFzaWMgPSB0cnVlO1xyXG5cclxuICAgIGhhbmRsZXJzLmFycmF5VW5tYXNrZWQgPSBmdW5jdGlvbiAobGVuZ3RoLCBoYW5kbGVyKSB7XHJcbiAgICAgICAgdmFyIGNoaWxkcmVuID0gW107XHJcbiAgICAgICAgZm9yICh2YXIgaWR4ID0gMDsgaWR4IDwgbGVuZ3RoOyArK2lkeCkge1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5wdXNoKGhhbmRsZXIpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB2YXIgcmVzdWx0ID0gaGFuZGxlcnMudHVwbGVVbm1hc2tlZChjaGlsZHJlbik7XHJcbiAgICAgICAgcmVzdWx0LmRlc2NyaXB0b3IgPSAnWycgKyBoYW5kbGVyLmRlc2NyaXB0b3IgKyAnOicgKyBsZW5ndGggKyAnXSc7XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH07XHJcblxyXG4gICAgaGFuZGxlcnMudHVwbGVVbm1hc2tlZCA9IGZ1bmN0aW9uIChjaGlsZHJlbikge1xyXG4gICAgICAgIHZhciBlbmNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplciwgZGF0YSwgbWFza3MpIHtcclxuICAgICAgICAgICAgaWYgKG1hc2tzID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgICAgICBtYXNrcyA9IG51bGw7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoY2hpbGQsIGlkeCkge1xyXG4gICAgICAgICAgICAgICAgY2hpbGQuZW5jb2RlKHNlcmlhbGl6ZXIsIGRhdGFbaWR4XSwgbWFza3MgJiYgbWFza3NbaWR4XSk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGRlY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjaGlsZHJlbi5tYXAoZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gY2hpbGQuZGVjb2RlKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBlbXB0eSA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBjaGlsZC5lbXB0eSgpO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBmdWxsTWFzayA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgdmFyIG5vbk51bGxDaGlsZCA9IGZhbHNlO1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0ge307XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIHZhciB2YWx1ZSA9IGNoaWxkLmZ1bGxNYXNrKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUgIT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgICAgICBub25OdWxsQ2hpbGQgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtpZHhdID0gdmFsdWU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBpZiAoIW5vbk51bGxDaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBieXRlQ291bnQgPSBjaGlsZHJlbi5yZWR1Y2UoZnVuY3Rpb24gKGFjY3VtLCBjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gYWNjdW0gKyBjaGlsZC5ieXRlQ291bnQ7XHJcbiAgICAgICAgfSwgMCk7XHJcbiAgICAgICAgdmFyIGNoaWxkRGVzY3JpcHRvcnMgPSBjaGlsZHJlbi5tYXAoZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjaGlsZC5kZXNjcmlwdG9yO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHZhciBkZXNjcmlwdG9yID0gJygnICsgY2hpbGREZXNjcmlwdG9ycy5qb2luKCcsJykgKyAnKSc7XHJcbiAgICAgICAgcmV0dXJuIG5ldyBIYW5kbGVyKGRlc2NyaXB0b3IsIGJ5dGVDb3VudCwgZW1wdHksIGVuY29kZSwgZGVjb2RlLCBmdWxsTWFzayk7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLmFycmF5TWFza2VkID0gZnVuY3Rpb24gKGxlbmd0aCwgaGFuZGxlciwgbWFza0JpdENvdW50KSB7XHJcbiAgICAgICAgdmFyIGNoaWxkcmVuID0gW107XHJcbiAgICAgICAgZm9yICh2YXIgaWR4ID0gMDsgaWR4IDwgbGVuZ3RoOyArK2lkeCkge1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5wdXNoKGhhbmRsZXIpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB2YXIgcmVzdWx0ID0gaGFuZGxlcnMudHVwbGVNYXNrZWQoY2hpbGRyZW4sIG1hc2tCaXRDb3VudCk7XHJcbiAgICAgICAgdmFyIG1hc2tTaXplID0gKHJlc3VsdC5ieXRlQ291bnQgLSAobGVuZ3RoICogaGFuZGxlci5ieXRlQ291bnQpKSAqIDg7XHJcbiAgICAgICAgcmVzdWx0LmRlc2NyaXB0b3IgPSAnWy8nICsgbWFza1NpemUgKyAnLycgKyBoYW5kbGVyLmRlc2NyaXB0b3IgKyAnOicgKyBsZW5ndGggKyAnXSc7XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH07XHJcblxyXG4gICAgaGFuZGxlcnMudHVwbGVNYXNrZWQgPSBmdW5jdGlvbiAoY2hpbGRyZW4sIG1hc2tCaXRDb3VudCkge1xyXG4gICAgICAgIHZhciBtYXNrQnl0ZXMgPSBNYXRoLmNlaWwoY2hpbGRyZW4ubGVuZ3RoIC8gOCk7XHJcbiAgICAgICAgaWYgKG1hc2tCaXRDb3VudCkge1xyXG4gICAgICAgICAgICBtYXNrQnl0ZXMgPSBNYXRoLm1heChtYXNrQnl0ZXMsIE1hdGguY2VpbChtYXNrQml0Q291bnQgLyA4KSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHZhciBtYXNrSGFuZGxlciA9IGhhbmRsZXJzLmFycmF5VW5tYXNrZWQobWFza0J5dGVzLCBoYW5kbGVycy51OCk7XHJcbiAgICAgICAgdmFyIG1hc2tBcnJheSA9IGZ1bmN0aW9uIChkYXRhLCBtYXNrcykge1xyXG4gICAgICAgICAgICBpZiAobWFza3MgPT09IHRydWUpIHtcclxuICAgICAgICAgICAgICAgIG1hc2tzID0gbnVsbDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB2YXIgbWFzayA9IHplcm9BcnJheShtYXNrQnl0ZXMpO1xyXG4gICAgICAgICAgICB2YXIgZXh0cmFNYXNrID0gbnVsbDtcclxuICAgICAgICAgICAgaWYgKG1hc2tzICYmICgnTUFTSycgaW4gbWFza3MpKSB7XHJcbiAgICAgICAgICAgICAgICBleHRyYU1hc2sgPSBtYXNrcy5NQVNLO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIHZhciB2YWx1ZSA9IGRhdGFbaWR4XTtcclxuICAgICAgICAgICAgICAgIGlmIChleHRyYU1hc2sgJiYgIWV4dHJhTWFza1tpZHhdKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKCFjaGlsZC5pc051bGwodmFsdWUpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbWFza1tNYXRoLmZsb29yKGlkeCAvIDgpXSB8PSAxIDw8IChpZHggJSA4KTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICByZXR1cm4gbWFzaztcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBlbmNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplciwgZGF0YSwgbWFza3MpIHtcclxuICAgICAgICAgICAgdmFyIG1hc2sgPSBtYXNrQXJyYXkoZGF0YSwgbWFza3MpO1xyXG5cclxuICAgICAgICAgICAgbWFza0hhbmRsZXIuZW5jb2RlKHNlcmlhbGl6ZXIsIG1hc2spO1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCwgaWR4KSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoaGFzQml0KG1hc2ssIGlkeCkpIHtcclxuICAgICAgICAgICAgICAgICAgICBjaGlsZC5lbmNvZGUoc2VyaWFsaXplciwgZGF0YVtpZHhdLCBtYXNrcyAmJiBtYXNrc1tpZHhdKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZGVjb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAgICAgdmFyIG1hc2sgPSBtYXNrSGFuZGxlci5kZWNvZGUoc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgIHJldHVybiBjaGlsZHJlbi5tYXAoZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIGlmIChoYXNCaXQobWFzaywgaWR4KSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBjaGlsZC5kZWNvZGUoc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZW1wdHkgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjaGlsZHJlbi5tYXAoZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gY2hpbGQuZW1wdHkoKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZnVsbE1hc2sgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHZhciByZXN1bHQgPSB7fTtcclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoY2hpbGQsIGlkeCkge1xyXG4gICAgICAgICAgICAgICAgdmFyIHZhbHVlID0gY2hpbGQuZnVsbE1hc2soKTtcclxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZSAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtpZHhdID0gdmFsdWU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXN1bHQuTUFTSyA9IGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgYnl0ZUNvdW50ID0gY2hpbGRyZW4ucmVkdWNlKGZ1bmN0aW9uIChhY2N1bSwgY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGFjY3VtICsgY2hpbGQuYnl0ZUNvdW50O1xyXG4gICAgICAgIH0sIG1hc2tCeXRlcyk7XHJcbiAgICAgICAgdmFyIGNoaWxkRGVzY3JpcHRvcnMgPSBjaGlsZHJlbi5tYXAoZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjaGlsZC5kZXNjcmlwdG9yO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHZhciBkZXNjcmlwdG9yID0gJygvJyArIChtYXNrQnl0ZXMgKiA4KSArICcvJyArIGNoaWxkRGVzY3JpcHRvcnMuam9pbignLCcpICsgJyknO1xyXG4gICAgICAgIHJldHVybiBuZXcgSGFuZGxlcihkZXNjcmlwdG9yLCBieXRlQ291bnQsIGVtcHR5LCBlbmNvZGUsIGRlY29kZSwgZnVsbE1hc2ssIG1hc2tBcnJheSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLm1hcFVubWFza2VkID0gZnVuY3Rpb24gKGNoaWxkcmVuKSB7XHJcbiAgICAgICAgdmFyIGVuY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyLCBkYXRhLCBtYXNrcykge1xyXG4gICAgICAgICAgICBpZiAobWFza3MgPT09IHRydWUpIHtcclxuICAgICAgICAgICAgICAgIG1hc2tzID0gbnVsbDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgY2hpbGQuaGFuZGxlci5lbmNvZGUoc2VyaWFsaXplciwgZGF0YVtjaGlsZC5rZXldLCBtYXNrcyAmJiBtYXNrc1tjaGlsZC5rZXldKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZGVjb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkLmtleV0gPSBjaGlsZC5oYW5kbGVyLmRlY29kZShzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZW1wdHkgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHZhciByZXN1bHQgPSB7fTtcclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgIHJlc3VsdFtjaGlsZC5rZXldID0gY2hpbGQuaGFuZGxlci5lbXB0eSgpO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBmdWxsTWFzayA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgdmFyIG5vbk51bGxDaGlsZCA9IGZhbHNlO1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0ge307XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgdmFsdWUgPSBjaGlsZC5oYW5kbGVyLmZ1bGxNYXNrKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUgIT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgICAgICBub25OdWxsQ2hpbGQgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjaGlsZC5rZXldID0gdmFsdWU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBpZiAoIW5vbk51bGxDaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBieXRlQ291bnQgPSBjaGlsZHJlbi5yZWR1Y2UoZnVuY3Rpb24gKGFjY3VtLCBjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gYWNjdW0gKyBjaGlsZC5oYW5kbGVyLmJ5dGVDb3VudDtcclxuICAgICAgICB9LCAwKTtcclxuICAgICAgICB2YXIgY2hpbGREZXNjcmlwdG9ycyA9IGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmtleSArICc6JyArIGNoaWxkLmhhbmRsZXIuZGVzY3JpcHRvcjtcclxuICAgICAgICB9KTtcclxuICAgICAgICB2YXIgZGVzY3JpcHRvciA9ICd7JyArIGNoaWxkRGVzY3JpcHRvcnMuam9pbignLCcpICsgJ30nO1xyXG4gICAgICAgIHJldHVybiBuZXcgSGFuZGxlcihkZXNjcmlwdG9yLCBieXRlQ291bnQsIGVtcHR5LCBlbmNvZGUsIGRlY29kZSwgZnVsbE1hc2spO1xyXG4gICAgfTtcclxuXHJcbiAgICBoYW5kbGVycy5tYXBNYXNrZWQgPSBmdW5jdGlvbiAoY2hpbGRyZW4sIG1hc2tCaXRDb3VudCkge1xyXG4gICAgICAgIHZhciBtYXNrQnl0ZXMgPSBNYXRoLmNlaWwoY2hpbGRyZW4ubGVuZ3RoIC8gOCk7XHJcbiAgICAgICAgaWYgKG1hc2tCaXRDb3VudCkge1xyXG4gICAgICAgICAgICBtYXNrQnl0ZXMgPSBNYXRoLm1heChtYXNrQnl0ZXMsIE1hdGguY2VpbChtYXNrQml0Q291bnQgLyA4KSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHZhciBtYXNrSGFuZGxlciA9IGhhbmRsZXJzLmFycmF5VW5tYXNrZWQobWFza0J5dGVzLCBoYW5kbGVycy51OCk7XHJcbiAgICAgICAgdmFyIG1hc2tBcnJheSA9IGZ1bmN0aW9uIChkYXRhLCBtYXNrcykge1xyXG4gICAgICAgICAgICBpZiAobWFza3MgPT09IHRydWUpIHtcclxuICAgICAgICAgICAgICAgIG1hc2tzID0gbnVsbDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB2YXIgbWFzayA9IHplcm9BcnJheShtYXNrQnl0ZXMpO1xyXG4gICAgICAgICAgICB2YXIgZXh0cmFNYXNrID0gbnVsbDtcclxuICAgICAgICAgICAgaWYgKG1hc2tzICYmICgnTUFTSycgaW4gbWFza3MpKSB7XHJcbiAgICAgICAgICAgICAgICBleHRyYU1hc2sgPSBtYXNrcy5NQVNLO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCwgaWR4KSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgdmFsdWUgPSBkYXRhW2NoaWxkLmtleV07XHJcbiAgICAgICAgICAgICAgICBpZiAoZXh0cmFNYXNrICYmICFleHRyYU1hc2tbY2hpbGQua2V5XSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmICghY2hpbGQuaGFuZGxlci5pc051bGwodmFsdWUpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbWFza1tNYXRoLmZsb29yKGlkeCAvIDgpXSB8PSAxIDw8IChpZHggJSA4KTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICByZXR1cm4gbWFzaztcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBlbmNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplciwgZGF0YSwgbWFza3MpIHtcclxuICAgICAgICAgICAgdmFyIG1hc2sgPSBtYXNrQXJyYXkoZGF0YSwgbWFza3MpO1xyXG5cclxuICAgICAgICAgICAgbWFza0hhbmRsZXIuZW5jb2RlKHNlcmlhbGl6ZXIsIG1hc2spO1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCwgaWR4KSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoaGFzQml0KG1hc2ssIGlkeCkpIHtcclxuICAgICAgICAgICAgICAgICAgICBjaGlsZC5oYW5kbGVyLmVuY29kZShzZXJpYWxpemVyLCBkYXRhW2NoaWxkLmtleV0sIG1hc2tzICYmIG1hc2tzW2NoaWxkLmtleV0pO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBkZWNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgICAgICB2YXIgbWFzayA9IG1hc2tIYW5kbGVyLmRlY29kZShzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCwgaWR4KSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoaGFzQml0KG1hc2ssIGlkeCkpIHtcclxuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY2hpbGQua2V5XSA9IGNoaWxkLmhhbmRsZXIuZGVjb2RlKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBlbXB0eSA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkLmtleV0gPSBjaGlsZC5oYW5kbGVyLmVtcHR5KCk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGZ1bGxNYXNrID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0ge307XHJcbiAgICAgICAgICAgIHZhciBtYXNrID0ge307XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgdmFsdWUgPSBjaGlsZC5oYW5kbGVyLmZ1bGxNYXNrKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUgIT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY2hpbGQua2V5XSA9IHZhbHVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgbWFza1tjaGlsZC5rZXldID0gdHJ1ZTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJlc3VsdC5NQVNLID0gbWFzaztcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBieXRlQ291bnQgPSBjaGlsZHJlbi5yZWR1Y2UoZnVuY3Rpb24gKGFjY3VtLCBjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gYWNjdW0gKyBjaGlsZC5oYW5kbGVyLmJ5dGVDb3VudDtcclxuICAgICAgICB9LCBtYXNrQnl0ZXMpO1xyXG4gICAgICAgIHZhciBjaGlsZERlc2NyaXB0b3JzID0gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gY2hpbGQua2V5ICsgJzonICsgY2hpbGQuaGFuZGxlci5kZXNjcmlwdG9yO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHZhciBkZXNjcmlwdG9yID0gJ3svJyArIChtYXNrQnl0ZXMgKiA4KSArICcvJyArIGNoaWxkRGVzY3JpcHRvcnMuam9pbignLCcpICsgJ30nO1xyXG4gICAgICAgIHJldHVybiBuZXcgSGFuZGxlcihkZXNjcmlwdG9yLCBieXRlQ291bnQsIGVtcHR5LCBlbmNvZGUsIGRlY29kZSwgZnVsbE1hc2ssIG1hc2tBcnJheSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGlmICghZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uKSB7XHJcbiAgICAgICAgZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uID0ge307XHJcbiAgICB9XHJcbiAgICBnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24uX2hhbmRsZXJzID0gaGFuZGxlcnM7XHJcblxyXG59KHRoaXMpKTtcclxuIiwiKGZ1bmN0aW9uIChnbG9iYWwpIHtcclxuICAgICd1c2Ugc3RyaWN0JztcclxuXHJcbiAgICBmdW5jdGlvbiBTdHJpbmdUb2tlbihwb3NpdGlvbiwgdmFsdWUpIHtcclxuICAgICAgICB0aGlzLnBvc2l0aW9uID0gcG9zaXRpb247XHJcbiAgICAgICAgdGhpcy52YWx1ZSA9IHZhbHVlO1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBudW1lcmljVGVzdCA9IC9eXFxkKyQvO1xyXG4gICAgdmFyIG5hbWVUZXN0ID0gL15cXHcrJC87XHJcblxyXG4gICAgdmFyIFRva2VuQ2F0ZWdvcmllcyA9IHtcclxuICAgICAgICBTWU1CT0w6IDAsXHJcbiAgICAgICAgTlVNQkVSOiAxLFxyXG4gICAgICAgIE5BTUU6IDIsXHJcbiAgICB9O1xyXG5cclxuICAgIGZ1bmN0aW9uIFRva2VuKHN0cmluZ1Rva2VuKSB7XHJcbiAgICAgICAgdGhpcy5wb3NpdGlvbiA9IHN0cmluZ1Rva2VuLnBvc2l0aW9uO1xyXG4gICAgICAgIHRoaXMudmFsdWUgPSBzdHJpbmdUb2tlbi52YWx1ZTtcclxuICAgICAgICBpZiAobnVtZXJpY1Rlc3QudGVzdCh0aGlzLnZhbHVlKSkge1xyXG4gICAgICAgICAgICB0aGlzLmNhdGVnb3J5ID0gVG9rZW5DYXRlZ29yaWVzLk5VTUJFUjtcclxuICAgICAgICAgICAgdGhpcy52YWx1ZSA9IHBhcnNlSW50KHRoaXMudmFsdWUpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAobmFtZVRlc3QudGVzdCh0aGlzLnZhbHVlKSkge1xyXG4gICAgICAgICAgICB0aGlzLmNhdGVnb3J5ID0gVG9rZW5DYXRlZ29yaWVzLk5BTUU7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdGhpcy5jYXRlZ29yeSA9IFRva2VuQ2F0ZWdvcmllcy5TWU1CT0w7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHZhciB2YWxpZENoYXJTZXRUZXN0ID0gL15be31cXFtcXF0oKVxcLz06LDtcXHdcXHNdKiQvO1xyXG5cclxuICAgIHZhciBpc1ZhbGlkID0gZnVuY3Rpb24gKHRleHQpIHtcclxuICAgICAgICByZXR1cm4gdmFsaWRDaGFyU2V0VGVzdC50ZXN0KHRleHQpO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgdG9rZW5pemVyID0gZnVuY3Rpb24gKHRleHQpIHtcclxuICAgICAgICBpZiAoIWlzVmFsaWQodGV4dCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQYXNzZWQgY29uZmlnIGNvbnRhaW5zIGludmFsaWQgY2hhcmFjdGVycycpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB2YXIgcmUgPSAvKFt7fVxcW1xcXSgpXFwvPTosO118XFx3KykvZztcclxuICAgICAgICB2YXIgbWF0Y2g7XHJcbiAgICAgICAgdmFyIG1hdGNoZXMgPSBbXTtcclxuICAgICAgICB3aGlsZSAoKG1hdGNoID0gcmUuZXhlYyh0ZXh0KSkgIT09IG51bGwpIHtcclxuICAgICAgICAgICAgbWF0Y2hlcy5wdXNoKG5ldyBTdHJpbmdUb2tlbihtYXRjaC5pbmRleCwgbWF0Y2hbMF0pKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG1hdGNoZXM7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBsZXhlciA9IGZ1bmN0aW9uICh0b2tlbnMpIHtcclxuICAgICAgICByZXR1cm4gdG9rZW5zLm1hcChmdW5jdGlvbiAodG9rZW4pIHtcclxuICAgICAgICAgICAgcmV0dXJuIG5ldyBUb2tlbih0b2tlbik7XHJcbiAgICAgICAgfSk7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBUeXBlQ2F0ZWdvcmllcyA9IHtcclxuICAgICAgICBOQU1FRDogMCxcclxuICAgICAgICBNQVBfVU5NQVNLRUQ6IDIsXHJcbiAgICAgICAgTUFQX01BU0tFRDogMyxcclxuICAgICAgICBUVVBMRV9VTk1BU0tFRDogNCxcclxuICAgICAgICBUVVBMRV9NQVNLRUQ6IDUsXHJcbiAgICAgICAgQVJSQVlfVU5NQVNLRUQ6IDYsXHJcbiAgICAgICAgQVJSQVlfTUFTS0VEOiA3LFxyXG4gICAgfTtcclxuXHJcbiAgICBmdW5jdGlvbiBUeXBlKGNhdGVnb3J5LCBwcm9wZXJ0aWVzLCBtYXNrKSB7XHJcbiAgICAgICAgdGhpcy5jYXRlZ29yeSA9IGNhdGVnb3J5O1xyXG4gICAgICAgIHRoaXMucHJvcGVydGllcyA9IHByb3BlcnRpZXM7XHJcbiAgICAgICAgdGhpcy5tYXNrID0gbWFzayB8fCAwO1xyXG4gICAgfVxyXG5cclxuICAgIFR5cGUucHJvdG90eXBlLmdlbmVyYXRlSGFuZGxlciA9IGZ1bmN0aW9uIChsaWJyYXJ5KSB7XHJcbiAgICAgICAgdmFyIGhhbmRsZXJzID0gZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uLl9oYW5kbGVycztcclxuICAgICAgICB2YXIgcHJvcHMgPSB0aGlzLnByb3BlcnRpZXM7XHJcbiAgICAgICAgdmFyIG1hc2sgPSB0aGlzLm1hc2s7XHJcbiAgICAgICAgdmFyIGhhbmRsZXIgPSBudWxsO1xyXG4gICAgICAgIHZhciBjaGlsZHJlbjtcclxuICAgICAgICBzd2l0Y2ggKHRoaXMuY2F0ZWdvcnkpIHtcclxuICAgICAgICAgICAgY2FzZSBUeXBlQ2F0ZWdvcmllcy5OQU1FRDpcclxuICAgICAgICAgICAgICAgIGlmIChwcm9wcyBpbiBoYW5kbGVycykge1xyXG4gICAgICAgICAgICAgICAgICAgIGhhbmRsZXIgPSBoYW5kbGVyc1twcm9wc107XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFoYW5kbGVyLmlzQmFzaWMpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaGFuZGxlciA9IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wc1swXSA9PT0gJ3MnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdmFyIGxlbmd0aCA9IHByb3BzLnN1YnN0cmluZygxKTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAobnVtZXJpY1Rlc3QudGVzdChsZW5ndGgpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGhhbmRsZXIgPSBoYW5kbGVycy5zdHJpbmcocGFyc2VJbnQobGVuZ3RoKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcyBpbiBsaWJyYXJ5KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaGFuZGxlciA9IGxpYnJhcnlbcHJvcHNdO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKCFoYW5kbGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogLTEsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yOiAnVW5yZWNvZ25pemVkIHR5cGUgXCInICsgcHJvcHMgKyAnXCInLFxyXG4gICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlcjtcclxuICAgICAgICAgICAgY2FzZSBUeXBlQ2F0ZWdvcmllcy5NQVBfVU5NQVNLRUQ6XHJcbiAgICAgICAgICAgICAgICBjaGlsZHJlbiA9IHByb3BzLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNoaWxkLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGhhbmRsZXI6IGNoaWxkLnZhbHVlLmdlbmVyYXRlSGFuZGxlcihsaWJyYXJ5KSxcclxuICAgICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlcnMubWFwVW5tYXNrZWQoY2hpbGRyZW4pO1xyXG4gICAgICAgICAgICBjYXNlIFR5cGVDYXRlZ29yaWVzLk1BUF9NQVNLRUQ6XHJcbiAgICAgICAgICAgICAgICBjaGlsZHJlbiA9IHByb3BzLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNoaWxkLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGhhbmRsZXI6IGNoaWxkLnZhbHVlLmdlbmVyYXRlSGFuZGxlcihsaWJyYXJ5KSxcclxuICAgICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlcnMubWFwTWFza2VkKGNoaWxkcmVuLCBtYXNrKTtcclxuICAgICAgICAgICAgY2FzZSBUeXBlQ2F0ZWdvcmllcy5UVVBMRV9VTk1BU0tFRDpcclxuICAgICAgICAgICAgICAgIGNoaWxkcmVuID0gcHJvcHMubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBjaGlsZC5nZW5lcmF0ZUhhbmRsZXIobGlicmFyeSk7XHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIHJldHVybiBoYW5kbGVycy50dXBsZVVubWFza2VkKGNoaWxkcmVuKTtcclxuICAgICAgICAgICAgY2FzZSBUeXBlQ2F0ZWdvcmllcy5UVVBMRV9NQVNLRUQ6XHJcbiAgICAgICAgICAgICAgICBjaGlsZHJlbiA9IHByb3BzLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gY2hpbGQuZ2VuZXJhdGVIYW5kbGVyKGxpYnJhcnkpO1xyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlcnMudHVwbGVNYXNrZWQoY2hpbGRyZW4sIG1hc2spO1xyXG4gICAgICAgICAgICBjYXNlIFR5cGVDYXRlZ29yaWVzLkFSUkFZX1VOTUFTS0VEOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZXJzLmFycmF5VW5tYXNrZWQocHJvcHMuY291bnQsIHByb3BzLnZhbHVlLmdlbmVyYXRlSGFuZGxlcihsaWJyYXJ5KSk7XHJcbiAgICAgICAgICAgIGNhc2UgVHlwZUNhdGVnb3JpZXMuQVJSQVlfTUFTS0VEOlxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZXJzLmFycmF5TWFza2VkKHByb3BzLmNvdW50LCBwcm9wcy52YWx1ZS5nZW5lcmF0ZUhhbmRsZXIobGlicmFyeSksIG1hc2spO1xyXG4gICAgICAgICAgICBkZWZhdWx0OlxyXG4gICAgICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiAtMSxcclxuICAgICAgICAgICAgICAgICAgICBlcnJvcjogJ1VucmVjb2duaXplZCB0eXBlIGNhdGVnb3J5JyxcclxuICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgcmVhZFRva2VuID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICB2YXIgdG9rZW4gPSBzZXJpYWxpemVyLmRhdGFWaWV3W3NlcmlhbGl6ZXIuaW5kZXhdO1xyXG4gICAgICAgIHNlcmlhbGl6ZXIuYWRkKDEpO1xyXG4gICAgICAgIGlmICghdG9rZW4pIHtcclxuICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgcG9zaXRpb246IC0xLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6ICdVbmV4cGVjdGVkIGVuZCBvZiBzdHJpbmcnLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gdG9rZW47XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBuYW1lUGFyc2VyID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICB2YXIgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgaWYgKHRva2VuLmNhdGVnb3J5ICE9PSBUb2tlbkNhdGVnb3JpZXMuTkFNRSkge1xyXG4gICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogdG9rZW4ucG9zaXRpb24sXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogJ0V4cGVjdGVkIG5hbWUsIGdvdDogXCInICsgdG9rZW4udmFsdWUgKyAnXCInLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodG9rZW4udmFsdWUgPT09ICdNQVNLJykge1xyXG4gICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogdG9rZW4ucG9zaXRpb24sXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogJ0Rpc2FsbG93ZWQgbmFtZSBcIk1BU0tcIiBnaXZlbicsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0b2tlbi52YWx1ZTtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIG51bWJlclBhcnNlciA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgdmFyIHRva2VuID0gcmVhZFRva2VuKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIGlmICh0b2tlbi5jYXRlZ29yeSAhPT0gVG9rZW5DYXRlZ29yaWVzLk5VTUJFUikge1xyXG4gICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogdG9rZW4ucG9zaXRpb24sXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogJ0V4cGVjdGVkIG51bWJlciwgZ290OiBcIicgKyB0b2tlbi52YWx1ZSArICdcIicsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0b2tlbi52YWx1ZTtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIGNvbnN1bWVTeW1ib2wgPSBmdW5jdGlvbiAoc2VyaWFsaXplciwgc3ltYm9sKSB7XHJcbiAgICAgICAgdmFyIHRva2VuID0gcmVhZFRva2VuKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSAhPT0gc3ltYm9sKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnRXhwZWN0ZWQgXCInICsgc3ltYm9sICsgJ1wiLCBnb3Q6IFwiJyArIHRva2VuLnZhbHVlICsgJ1wiJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBtYXNrUGFyc2VyID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAvLyBcIi8vXCIgb3IgXCIvPE5VTUJFUj4vXCIsIG90aGVyd2lzZSB0aGVyZSBpcyBubyBtYXNrXHJcbiAgICAgICAgLy8gTGFiZWxlZCB3aXRoIDxNQVNLPiBpbiBjb21tZW50cyBiZWxvd1xyXG4gICAgICAgIHZhciB0b2tlbiA9IHJlYWRUb2tlbihzZXJpYWxpemVyKTtcclxuICAgICAgICBpZiAodG9rZW4udmFsdWUgIT09ICcvJykge1xyXG4gICAgICAgICAgICBzZXJpYWxpemVyLmFkZCgtMSk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBtYXNrZWQ6IGZhbHNlLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICB0b2tlbiA9IHJlYWRUb2tlbihzZXJpYWxpemVyKTtcclxuICAgICAgICBpZiAodG9rZW4udmFsdWUgPT09ICcvJykge1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgbWFza2VkOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgZGVmaW5lZDogZmFsc2UsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0b2tlbi5jYXRlZ29yeSAhPT0gVG9rZW5DYXRlZ29yaWVzLk5VTUJFUikge1xyXG4gICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogdG9rZW4ucG9zaXRpb24sXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogJ0V4cGVjdGVkIFwiL1wiIG9yIG51bWJlcicsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHZhciB2YWx1ZSA9IHRva2VuLnZhbHVlO1xyXG4gICAgICAgIHRva2VuID0gcmVhZFRva2VuKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSAhPT0gJy8nKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnRXhwZWN0ZWQgXCIvXCInLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBtYXNrZWQ6IHRydWUsXHJcbiAgICAgICAgICAgIGRlZmluZWQ6IHRydWUsXHJcbiAgICAgICAgICAgIHZhbHVlOiB2YWx1ZSxcclxuICAgICAgICB9O1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgdHlwZU1hcFBhcnNlciA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgLy8gezxNQVNLPiA8TkFNRT46PFRZUEU+LCA8TkFNRT46PFRZUEU+LCA8TkFNRT46PFRZUEU+fVxyXG4gICAgICAgIHZhciBtYXNrID0gbWFza1BhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICB2YXIgY2hpbGRyZW4gPSBbXTtcclxuICAgICAgICB3aGlsZSAodHJ1ZSkge1xyXG4gICAgICAgICAgICB2YXIgbmFtZSA9IG5hbWVQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgIGNvbnN1bWVTeW1ib2woc2VyaWFsaXplciwgJzonKTtcclxuICAgICAgICAgICAgdmFyIHZhbHVlID0gdHlwZVBhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgY2hpbGRyZW4ucHVzaCh7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiBuYW1lLFxyXG4gICAgICAgICAgICAgICAgdmFsdWU6IHZhbHVlLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgdmFyIHRva2VuID0gcmVhZFRva2VuKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICBpZiAodG9rZW4udmFsdWUgPT09ICd9Jykge1xyXG4gICAgICAgICAgICAgICAgaWYgKG1hc2subWFza2VkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hc2suZGVmaW5lZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFR5cGUoVHlwZUNhdGVnb3JpZXMuTUFQX01BU0tFRCwgY2hpbGRyZW4sIG1hc2sudmFsdWUpO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgVHlwZShUeXBlQ2F0ZWdvcmllcy5NQVBfTUFTS0VELCBjaGlsZHJlbik7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFR5cGUoVHlwZUNhdGVnb3JpZXMuTUFQX1VOTUFTS0VELCBjaGlsZHJlbik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHRva2VuLnZhbHVlICE9PSAnLCcpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogdG9rZW4ucG9zaXRpb24sXHJcbiAgICAgICAgICAgICAgICAgICAgZXJyb3I6ICdVbmV4cGVjdGVkIHRva2VuIGFmdGVyIG1hcCBlbGVtZW50OiBcIicgKyB0b2tlbi52YWx1ZSArICdcIicsXHJcbiAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgdHlwZVR1cGxlUGFyc2VyID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAvLyAoPE1BU0s+IDxUWVBFPiwgPFRZUEU+LCA8VFlQRT4pXHJcbiAgICAgICAgdmFyIG1hc2sgPSBtYXNrUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIHZhciBjaGlsZHJlbiA9IFtdO1xyXG4gICAgICAgIHdoaWxlICh0cnVlKSB7XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLnB1c2godHlwZVBhcnNlcihzZXJpYWxpemVyKSk7XHJcbiAgICAgICAgICAgIHZhciB0b2tlbiA9IHJlYWRUb2tlbihzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgaWYgKHRva2VuLnZhbHVlID09PSAnKScpIHtcclxuICAgICAgICAgICAgICAgIGlmIChtYXNrLm1hc2tlZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChtYXNrLmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLlRVUExFX01BU0tFRCwgY2hpbGRyZW4sIG1hc2sudmFsdWUpO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgVHlwZShUeXBlQ2F0ZWdvcmllcy5UVVBMRV9NQVNLRUQsIGNoaWxkcmVuKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgVHlwZShUeXBlQ2F0ZWdvcmllcy5UVVBMRV9VTk1BU0tFRCwgY2hpbGRyZW4pO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICh0b2tlbi52YWx1ZSAhPT0gJywnKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiAnVW5leHBlY3RlZCB0b2tlbiBhZnRlciB0dXBsZSBlbGVtZW50OiBcIicgKyB0b2tlbi52YWx1ZSArICdcIicsXHJcbiAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgdHlwZUFycmF5UGFyc2VyID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAvLyBbPE1BU0s+IDxUWVBFPjo8TlVNQkVSPl1cclxuICAgICAgICB2YXIgbWFzayA9IG1hc2tQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgdmFyIHZhbHVlID0gdHlwZVBhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICBjb25zdW1lU3ltYm9sKHNlcmlhbGl6ZXIsICc6Jyk7XHJcbiAgICAgICAgdmFyIGNvdW50ID0gbnVtYmVyUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIGNvbnN1bWVTeW1ib2woc2VyaWFsaXplciwgJ10nKTtcclxuICAgICAgICB2YXIgY2hpbGRyZW4gPSB7XHJcbiAgICAgICAgICAgIHZhbHVlOiB2YWx1ZSxcclxuICAgICAgICAgICAgY291bnQ6IGNvdW50LFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgaWYgKG1hc2subWFza2VkKSB7XHJcbiAgICAgICAgICAgIGlmIChtYXNrLmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBuZXcgVHlwZShUeXBlQ2F0ZWdvcmllcy5BUlJBWV9NQVNLRUQsIGNoaWxkcmVuLCBtYXNrLnZhbHVlKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBuZXcgVHlwZShUeXBlQ2F0ZWdvcmllcy5BUlJBWV9NQVNLRUQsIGNoaWxkcmVuKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHJldHVybiBuZXcgVHlwZShUeXBlQ2F0ZWdvcmllcy5BUlJBWV9VTk1BU0tFRCwgY2hpbGRyZW4pO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgdmFyIHR5cGVQYXJzZXIgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIC8vIE9wdGlvbnM6XHJcbiAgICAgICAgLy8gLSA8TkFNRT5cclxuICAgICAgICAvLyAtIFR1cGxlXHJcbiAgICAgICAgLy8gLSBBcnJheVxyXG4gICAgICAgIC8vIC0gTWFwXHJcbiAgICAgICAgdmFyIHRva2VuID0gcmVhZFRva2VuKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIGlmICghdG9rZW4pIHtcclxuICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgcG9zaXRpb246IC0xLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6ICdVbmV4cGVjdGVkIGVuZCBvZiBzdHJpbmcnLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodG9rZW4uY2F0ZWdvcnkgPT09IFRva2VuQ2F0ZWdvcmllcy5OVU1CRVIpIHtcclxuICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6ICdVbmV4cGVjdGVkIG51bWJlciwgdHlwZSBleHBlY3RlZCcsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0b2tlbi5jYXRlZ29yeSA9PT0gVG9rZW5DYXRlZ29yaWVzLk5BTUUpIHtcclxuICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLk5BTUVELCB0b2tlbi52YWx1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSA9PT0gJ3snKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB0eXBlTWFwUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodG9rZW4udmFsdWUgPT09ICdbJykge1xyXG4gICAgICAgICAgICByZXR1cm4gdHlwZUFycmF5UGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodG9rZW4udmFsdWUgPT09ICcoJykge1xyXG4gICAgICAgICAgICByZXR1cm4gdHlwZVR1cGxlUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgZXJyb3I6ICdVbmV4cGVjdGVkIHRva2VuIHdoZW4gZGVzY3JpYmluZyB0eXBlOiBcIicgKyB0b2tlbi52YWx1ZSArICdcIicsXHJcbiAgICAgICAgfTtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIHBhcnNlciA9IGZ1bmN0aW9uICh0b2tlbnMsIHNvdXJjZSkge1xyXG4gICAgICAgIHZhciBzZXJpYWxpemVyID0gbmV3IGdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbi5TZXJpYWxpemVyKHRva2Vucyk7XHJcbiAgICAgICAgdmFyIHN0cnVjdHVyZXMgPSBbXTtcclxuICAgICAgICB3aGlsZSAoc2VyaWFsaXplci5pbmRleCA8IHNlcmlhbGl6ZXIuZGF0YVZpZXcubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHZhciBuYW1lID0gbmFtZVBhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgaWYgKG5hbWVbMF0gIT09IG5hbWVbMF0udG9VcHBlckNhc2UoKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiAtMSxcclxuICAgICAgICAgICAgICAgICAgICBlcnJvcjogJ1N0cnVjdHVyZSBuYW1lcyBjYW5ub3Qgc3RhcnQgd2l0aCBsb3dlcmNhc2UgbGV0dGVycycsXHJcbiAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN1bWVTeW1ib2woc2VyaWFsaXplciwgJz0nKTtcclxuICAgICAgICAgICAgdmFyIHZhbHVlID0gdHlwZVBhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgY29uc3VtZVN5bWJvbChzZXJpYWxpemVyLCAnOycpO1xyXG4gICAgICAgICAgICBzdHJ1Y3R1cmVzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgbmFtZTogbmFtZSxcclxuICAgICAgICAgICAgICAgIHZhbHVlOiB2YWx1ZSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBzdHJ1Y3R1cmVzO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgY3JlYXRlSGFuZGxlcnMgPSBmdW5jdGlvbiAoc3RydWN0dXJlKSB7XHJcbiAgICAgICAgdmFyIGxpYnJhcnkgPSB7fTtcclxuICAgICAgICBzdHJ1Y3R1cmUuZm9yRWFjaChmdW5jdGlvbiAoZW50cnkpIHtcclxuICAgICAgICAgICAgbGlicmFyeVtlbnRyeS5uYW1lXSA9IGVudHJ5LnZhbHVlLmdlbmVyYXRlSGFuZGxlcihsaWJyYXJ5KTtcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXR1cm4gbGlicmFyeTtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIHBhcnNlID0gZnVuY3Rpb24gKHRleHQpIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gY3JlYXRlSGFuZGxlcnMocGFyc2VyKGxleGVyKHRva2VuaXplcih0ZXh0KSwgdGV4dCksIHRleHQpKTtcclxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGVyci5lcnJvcik7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBpZiAoIWdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbikge1xyXG4gICAgICAgIGdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbiA9IHt9O1xyXG4gICAgfVxyXG5cclxuICAgIGdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbi5fcGFyc2VyU3RlcHMgPSB7XHJcbiAgICAgICAgdG9rZW5pemVyOiB0b2tlbml6ZXIsXHJcbiAgICAgICAgbGV4ZXI6IGxleGVyLFxyXG4gICAgICAgIHBhcnNlcjogcGFyc2VyLFxyXG4gICAgICAgIFRva2VuQ2F0ZWdvcmllczogVG9rZW5DYXRlZ29yaWVzLFxyXG4gICAgICAgIFR5cGVDYXRlZ29yaWVzOiBUeXBlQ2F0ZWdvcmllcyxcclxuICAgICAgICBTdHJpbmdUb2tlbjogU3RyaW5nVG9rZW4sXHJcbiAgICAgICAgVG9rZW46IFRva2VuLFxyXG4gICAgICAgIFR5cGU6IFR5cGUsXHJcbiAgICB9O1xyXG5cclxuICAgIGdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbi5wYXJzZSA9IHBhcnNlO1xyXG5cclxufSh0aGlzKSk7XHJcbiIsIihmdW5jdGlvbiAoZ2xvYmFsKSB7XHJcbiAgICAndXNlIHN0cmljdCc7XHJcblxyXG4gICAgZnVuY3Rpb24gU2VyaWFsaXplcihkYXRhVmlldykge1xyXG4gICAgICAgIHRoaXMuaW5kZXggPSAwO1xyXG4gICAgICAgIHRoaXMuZGF0YVZpZXcgPSBkYXRhVmlldztcclxuICAgIH1cclxuXHJcbiAgICBTZXJpYWxpemVyLnByb3RvdHlwZS5hZGQgPSBmdW5jdGlvbiAoaW5jcmVtZW50KSB7XHJcbiAgICAgICAgdGhpcy5pbmRleCArPSBpbmNyZW1lbnQ7XHJcbiAgICB9O1xyXG5cclxuICAgIGlmICghZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uKSB7XHJcbiAgICAgICAgZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uID0ge307XHJcbiAgICB9XHJcbiAgICBnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24uU2VyaWFsaXplciA9IFNlcmlhbGl6ZXI7XHJcblxyXG59KHRoaXMpKTtcclxuIl19
