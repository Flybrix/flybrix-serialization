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

    function Handler(descriptor, byteCount, empty, encode, decode, fullMask, maskArray) {
        this.descriptor = descriptor;
        this.byteCount = byteCount;
        this.encode = encode;
        this.decode = decode;
        this.empty = empty;
        this.fullMask = fullMask || nullMask;
        this.maskArray = maskArray || nullMaskArray;
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
            children.forEach(function (_, idx) {
                var value = data[idx];
                if (extraMask && !extraMask[idx]) {
                    return;
                }
                if (value !== null && value !== undefined) {
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
                if (value !== null && value !== undefined) {
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

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1vZHVsZS5qcyIsImhhbmRsZXJzLmpzIiwicGFyc2VyLmpzIiwic2VyaWFsaXplci5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FDVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUM3YUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQ2haQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJmbHlicml4LXNlcmlhbGl6YXRpb24uanMiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gKCkge1xyXG4gICAgJ3VzZSBzdHJpY3QnO1xyXG5cclxuICAgIGFuZ3VsYXIubW9kdWxlKCdmbHlicml4U2VyaWFsaXphdGlvbicsIFtdKS5mYWN0b3J5KCdmYlNlcmlhbGl6ZXInLCBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgU2VyaWFsaXplcjogRmx5YnJpeFNlcmlhbGl6YXRpb24uU2VyaWFsaXplcixcclxuICAgICAgICAgICAgY3JlYXRlSGFuZGxlcjogRmx5YnJpeFNlcmlhbGl6YXRpb24ucGFyc2UsXHJcbiAgICAgICAgfTtcclxuICAgIH0pO1xyXG59KTtcclxuIiwiKGZ1bmN0aW9uIChnbG9iYWwpIHtcclxuICAgICd1c2Ugc3RyaWN0JztcclxuXHJcbiAgICB2YXIgbnVsbE1hc2sgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBudWxsTWFza0FycmF5ID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIHJldHVybiBbXTtcclxuICAgIH07XHJcblxyXG4gICAgZnVuY3Rpb24gSGFuZGxlcihkZXNjcmlwdG9yLCBieXRlQ291bnQsIGVtcHR5LCBlbmNvZGUsIGRlY29kZSwgZnVsbE1hc2ssIG1hc2tBcnJheSkge1xyXG4gICAgICAgIHRoaXMuZGVzY3JpcHRvciA9IGRlc2NyaXB0b3I7XHJcbiAgICAgICAgdGhpcy5ieXRlQ291bnQgPSBieXRlQ291bnQ7XHJcbiAgICAgICAgdGhpcy5lbmNvZGUgPSBlbmNvZGU7XHJcbiAgICAgICAgdGhpcy5kZWNvZGUgPSBkZWNvZGU7XHJcbiAgICAgICAgdGhpcy5lbXB0eSA9IGVtcHR5O1xyXG4gICAgICAgIHRoaXMuZnVsbE1hc2sgPSBmdWxsTWFzayB8fCBudWxsTWFzaztcclxuICAgICAgICB0aGlzLm1hc2tBcnJheSA9IG1hc2tBcnJheSB8fCBudWxsTWFza0FycmF5O1xyXG4gICAgfVxyXG5cclxuICAgIHZhciBoYW5kbGVycyA9IHt9O1xyXG5cclxuICAgIHZhciBoYXNCaXQgPSBmdW5jdGlvbiAobWFzaywgaWR4KSB7XHJcbiAgICAgICAgcmV0dXJuIChtYXNrW01hdGguZmxvb3IoaWR4IC8gOCldICYgKDEgPDwgKGlkeCAlIDgpKSkgIT09IDA7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBlbXB0eU51bWVyaWMgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgcmV0dXJuIDA7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciB6ZXJvQXJyYXkgPSBmdW5jdGlvbiAobCkge1xyXG4gICAgICAgIHZhciByZXN1bHQgPSBbXTtcclxuICAgICAgICBmb3IgKHZhciBpZHggPSAwOyBpZHggPCBsOyArK2lkeCkge1xyXG4gICAgICAgICAgICByZXN1bHQucHVzaCgwKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIGNyZWF0ZU51bWVyaWNUeXBlID0gZnVuY3Rpb24gKGtleVNob3J0LCBrZXksIGJ5dGVDb3VudCkge1xyXG4gICAgICAgIHZhciBlbmNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplciwgZGF0YSkge1xyXG4gICAgICAgICAgICBzZXJpYWxpemVyLmRhdGFWaWV3WydzZXQnICsga2V5XShzZXJpYWxpemVyLmluZGV4LCBkYXRhLCAxKTtcclxuICAgICAgICAgICAgc2VyaWFsaXplci5hZGQoYnl0ZUNvdW50KTtcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICB2YXIgZGVjb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAgICAgdmFyIGRhdGEgPSBzZXJpYWxpemVyLmRhdGFWaWV3WydnZXQnICsga2V5XShzZXJpYWxpemVyLmluZGV4LCAxKTtcclxuICAgICAgICAgICAgc2VyaWFsaXplci5hZGQoYnl0ZUNvdW50KTtcclxuICAgICAgICAgICAgcmV0dXJuIGRhdGE7XHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgdmFyIGhhbmRsZXIgPSBuZXcgSGFuZGxlcihrZXlTaG9ydCwgYnl0ZUNvdW50LCBlbXB0eU51bWVyaWMsIGVuY29kZSwgZGVjb2RlKTtcclxuXHJcbiAgICAgICAgaGFuZGxlci5pc0Jhc2ljID0gdHJ1ZTtcclxuXHJcbiAgICAgICAgcmV0dXJuIGhhbmRsZXI7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLnU4ID0gY3JlYXRlTnVtZXJpY1R5cGUoJ3U4JywgJ1VpbnQ4JywgMSk7XHJcbiAgICBoYW5kbGVycy51MTYgPSBjcmVhdGVOdW1lcmljVHlwZSgndTE2JywgJ1VpbnQxNicsIDIpO1xyXG4gICAgaGFuZGxlcnMudTMyID0gY3JlYXRlTnVtZXJpY1R5cGUoJ3UzMicsICdVaW50MzInLCA0KTtcclxuICAgIGhhbmRsZXJzLmk4ID0gY3JlYXRlTnVtZXJpY1R5cGUoJ2k4JywgJ0ludDgnLCAxKTtcclxuICAgIGhhbmRsZXJzLmkxNiA9IGNyZWF0ZU51bWVyaWNUeXBlKCdpMTYnLCAnSW50MTYnLCAyKTtcclxuICAgIGhhbmRsZXJzLmkzMiA9IGNyZWF0ZU51bWVyaWNUeXBlKCdpMzInLCAnSW50MzInLCA0KTtcclxuICAgIGhhbmRsZXJzLmYzMiA9IGNyZWF0ZU51bWVyaWNUeXBlKCdmMzInLCAnRmxvYXQzMicsIDQpO1xyXG4gICAgaGFuZGxlcnMuZjY0ID0gY3JlYXRlTnVtZXJpY1R5cGUoJ2Y2NCcsICdGbG9hdDY0JywgOCk7XHJcblxyXG4gICAgaGFuZGxlcnMuYm9vbCA9IG5ldyBIYW5kbGVyKFxyXG4gICAgICAgICdib29sJyxcclxuICAgICAgICBoYW5kbGVycy51OC5ieXRlQ291bnQsXHJcbiAgICAgICAgZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgfSxcclxuICAgICAgICBmdW5jdGlvbiAoc2VyaWFsaXplciwgZGF0YSkge1xyXG4gICAgICAgICAgICBoYW5kbGVycy51OC5lbmNvZGUoc2VyaWFsaXplciwgZGF0YSA/IDEgOiAwKTtcclxuICAgICAgICB9LFxyXG4gICAgICAgIGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBoYW5kbGVycy51OC5kZWNvZGUoc2VyaWFsaXplcikgIT09IDA7XHJcbiAgICAgICAgfSk7XHJcbiAgICBoYW5kbGVycy5ib29sLmlzQmFzaWMgPSB0cnVlO1xyXG5cclxuICAgIGhhbmRsZXJzLnZvaWQgPSBuZXcgSGFuZGxlcihcclxuICAgICAgICAndm9pZCcsXHJcbiAgICAgICAgMCxcclxuICAgICAgICBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgIH0sXHJcbiAgICAgICAgZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEpIHtcclxuICAgICAgICB9LFxyXG4gICAgICAgIGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgfSk7XHJcbiAgICBoYW5kbGVycy52b2lkLmlzQmFzaWMgPSB0cnVlO1xyXG5cclxuICAgIHZhciBhc2NpaUVuY29kZSA9IGZ1bmN0aW9uIChuYW1lLCBsZW5ndGgpIHtcclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSBuZXcgVWludDhBcnJheShsZW5ndGgpO1xyXG4gICAgICAgIG5hbWUuc3BsaXQoJycpLmZvckVhY2goZnVuY3Rpb24gKGMsIGlkeCkge1xyXG4gICAgICAgICAgICByZXNwb25zZVtpZHhdID0gYy5jaGFyQ29kZUF0KDApO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJlc3BvbnNlW2xlbmd0aCAtIDFdID0gMDtcclxuICAgICAgICByZXR1cm4gcmVzcG9uc2U7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBhc2NpaURlY29kZSA9IGZ1bmN0aW9uIChuYW1lLCBsZW5ndGgpIHtcclxuICAgICAgICB2YXIgcmVzcG9uc2UgPSAnJztcclxuICAgICAgICB2YXIgbCA9IE1hdGgubWluKG5hbWUubGVuZ3RoLCBsZW5ndGggLSAxKTtcclxuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGw7ICsraSkge1xyXG4gICAgICAgICAgICBpZiAobmFtZVtpXSA9PT0gMCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlc3BvbnNlICs9IFN0cmluZy5mcm9tQ2hhckNvZGUobmFtZVtpXSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiByZXNwb25zZTtcclxuICAgIH07XHJcblxyXG4gICAgaGFuZGxlcnMuc3RyaW5nID0gZnVuY3Rpb24gKGxlbmd0aCkge1xyXG4gICAgICAgIHZhciBoYW5kbGVyID0gaGFuZGxlcnMuYXJyYXlVbm1hc2tlZChsZW5ndGgsIGhhbmRsZXJzLnU4KTtcclxuICAgICAgICB2YXIgZW5jb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEpIHtcclxuICAgICAgICAgICAgaGFuZGxlci5lbmNvZGUoc2VyaWFsaXplciwgYXNjaWlFbmNvZGUoZGF0YSwgbGVuZ3RoKSk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZGVjb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGFzY2lpRGVjb2RlKGhhbmRsZXIuZGVjb2RlKHNlcmlhbGl6ZXIpLCBsZW5ndGgpO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGVtcHR5ID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICByZXR1cm4gJyc7XHJcbiAgICAgICAgfTtcclxuICAgICAgICByZXR1cm4gbmV3IEhhbmRsZXIoJ3MnICsgbGVuZ3RoLCBsZW5ndGgsIGVtcHR5LCBlbmNvZGUsIGRlY29kZSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLnMgPSBuZXcgSGFuZGxlcihcclxuICAgICAgICAncycsXHJcbiAgICAgICAgMCxcclxuICAgICAgICBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiAnJztcclxuICAgICAgICB9LFxyXG4gICAgICAgIGZ1bmN0aW9uIChzZXJpYWxpemVyLCBkYXRhKSB7XHJcbiAgICAgICAgICAgIHZhciBieXRlQ291bnQgPSBNYXRoLm1pbihkYXRhLmxlbmd0aCwgc2VyaWFsaXplci5kYXRhVmlldy5ieXRlTGVuZ3RoIC0gc2VyaWFsaXplci5pbmRleCk7XHJcbiAgICAgICAgICAgIGZvciAodmFyIGlkeCA9IDA7IGlkeCA8IGJ5dGVDb3VudDsgKytpZHgpIHtcclxuICAgICAgICAgICAgICAgIGhhbmRsZXJzLnU4LmVuY29kZShzZXJpYWxpemVyLCBkYXRhLmNoYXJDb2RlQXQoaWR4KSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHNlcmlhbGl6ZXIuaW5kZXggPCBzZXJpYWxpemVyLmRhdGFWaWV3LmJ5dGVMZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIGhhbmRsZXJzLnU4LmVuY29kZShzZXJpYWxpemVyLCAwKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3BvbnNlID0gJyc7XHJcbiAgICAgICAgICAgIHZhciBieXRlQ291bnQgPSBzZXJpYWxpemVyLmRhdGFWaWV3LmJ5dGVMZW5ndGggLSBzZXJpYWxpemVyLmluZGV4O1xyXG4gICAgICAgICAgICB3aGlsZSAoYnl0ZUNvdW50LS0gPiAwKSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgY2hhckNvZGUgPSBoYW5kbGVycy51OC5kZWNvZGUoc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWNoYXJDb2RlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcmVzcG9uc2UgKz0gU3RyaW5nLmZyb21DaGFyQ29kZShjaGFyQ29kZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xyXG4gICAgICAgIH0pO1xyXG4gICAgaGFuZGxlcnMucy5pc0Jhc2ljID0gdHJ1ZTtcclxuXHJcbiAgICBoYW5kbGVycy5hcnJheVVubWFza2VkID0gZnVuY3Rpb24gKGxlbmd0aCwgaGFuZGxlcikge1xyXG4gICAgICAgIHZhciBjaGlsZHJlbiA9IFtdO1xyXG4gICAgICAgIGZvciAodmFyIGlkeCA9IDA7IGlkeCA8IGxlbmd0aDsgKytpZHgpIHtcclxuICAgICAgICAgICAgY2hpbGRyZW4ucHVzaChoYW5kbGVyKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIHJlc3VsdCA9IGhhbmRsZXJzLnR1cGxlVW5tYXNrZWQoY2hpbGRyZW4pO1xyXG4gICAgICAgIHJlc3VsdC5kZXNjcmlwdG9yID0gJ1snICsgaGFuZGxlci5kZXNjcmlwdG9yICsgJzonICsgbGVuZ3RoICsgJ10nO1xyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLnR1cGxlVW5tYXNrZWQgPSBmdW5jdGlvbiAoY2hpbGRyZW4pIHtcclxuICAgICAgICB2YXIgZW5jb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEsIG1hc2tzKSB7XHJcbiAgICAgICAgICAgIGlmIChtYXNrcyA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICAgICAgbWFza3MgPSBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIGNoaWxkLmVuY29kZShzZXJpYWxpemVyLCBkYXRhW2lkeF0sIG1hc2tzICYmIG1hc2tzW2lkeF0pO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBkZWNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgICAgICByZXR1cm4gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmRlY29kZShzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZW1wdHkgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjaGlsZHJlbi5tYXAoZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gY2hpbGQuZW1wdHkoKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZnVsbE1hc2sgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHZhciBub25OdWxsQ2hpbGQgPSBmYWxzZTtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCwgaWR4KSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgdmFsdWUgPSBjaGlsZC5mdWxsTWFzaygpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbm9uTnVsbENoaWxkID0gdHJ1ZTtcclxuICAgICAgICAgICAgICAgICAgICByZXN1bHRbaWR4XSA9IHZhbHVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgaWYgKCFub25OdWxsQ2hpbGQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgYnl0ZUNvdW50ID0gY2hpbGRyZW4ucmVkdWNlKGZ1bmN0aW9uIChhY2N1bSwgY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGFjY3VtICsgY2hpbGQuYnl0ZUNvdW50O1xyXG4gICAgICAgIH0sIDApO1xyXG4gICAgICAgIHZhciBjaGlsZERlc2NyaXB0b3JzID0gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gY2hpbGQuZGVzY3JpcHRvcjtcclxuICAgICAgICB9KTtcclxuICAgICAgICB2YXIgZGVzY3JpcHRvciA9ICcoJyArIGNoaWxkRGVzY3JpcHRvcnMuam9pbignLCcpICsgJyknO1xyXG4gICAgICAgIHJldHVybiBuZXcgSGFuZGxlcihkZXNjcmlwdG9yLCBieXRlQ291bnQsIGVtcHR5LCBlbmNvZGUsIGRlY29kZSwgZnVsbE1hc2spO1xyXG4gICAgfTtcclxuXHJcbiAgICBoYW5kbGVycy5hcnJheU1hc2tlZCA9IGZ1bmN0aW9uIChsZW5ndGgsIGhhbmRsZXIsIG1hc2tCaXRDb3VudCkge1xyXG4gICAgICAgIHZhciBjaGlsZHJlbiA9IFtdO1xyXG4gICAgICAgIGZvciAodmFyIGlkeCA9IDA7IGlkeCA8IGxlbmd0aDsgKytpZHgpIHtcclxuICAgICAgICAgICAgY2hpbGRyZW4ucHVzaChoYW5kbGVyKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIHJlc3VsdCA9IGhhbmRsZXJzLnR1cGxlTWFza2VkKGNoaWxkcmVuLCBtYXNrQml0Q291bnQpO1xyXG4gICAgICAgIHZhciBtYXNrU2l6ZSA9IChyZXN1bHQuYnl0ZUNvdW50IC0gKGxlbmd0aCAqIGhhbmRsZXIuYnl0ZUNvdW50KSkgKiA4O1xyXG4gICAgICAgIHJlc3VsdC5kZXNjcmlwdG9yID0gJ1svJyArIG1hc2tTaXplICsgJy8nICsgaGFuZGxlci5kZXNjcmlwdG9yICsgJzonICsgbGVuZ3RoICsgJ10nO1xyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLnR1cGxlTWFza2VkID0gZnVuY3Rpb24gKGNoaWxkcmVuLCBtYXNrQml0Q291bnQpIHtcclxuICAgICAgICB2YXIgbWFza0J5dGVzID0gTWF0aC5jZWlsKGNoaWxkcmVuLmxlbmd0aCAvIDgpO1xyXG4gICAgICAgIGlmIChtYXNrQml0Q291bnQpIHtcclxuICAgICAgICAgICAgbWFza0J5dGVzID0gTWF0aC5tYXgobWFza0J5dGVzLCBNYXRoLmNlaWwobWFza0JpdENvdW50IC8gOCkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB2YXIgbWFza0hhbmRsZXIgPSBoYW5kbGVycy5hcnJheVVubWFza2VkKG1hc2tCeXRlcywgaGFuZGxlcnMudTgpO1xyXG4gICAgICAgIHZhciBtYXNrQXJyYXkgPSBmdW5jdGlvbiAoZGF0YSwgbWFza3MpIHtcclxuICAgICAgICAgICAgaWYgKG1hc2tzID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgICAgICBtYXNrcyA9IG51bGw7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdmFyIG1hc2sgPSB6ZXJvQXJyYXkobWFza0J5dGVzKTtcclxuICAgICAgICAgICAgdmFyIGV4dHJhTWFzayA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChtYXNrcyAmJiAoJ01BU0snIGluIG1hc2tzKSkge1xyXG4gICAgICAgICAgICAgICAgZXh0cmFNYXNrID0gbWFza3MuTUFTSztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChfLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIHZhciB2YWx1ZSA9IGRhdGFbaWR4XTtcclxuICAgICAgICAgICAgICAgIGlmIChleHRyYU1hc2sgJiYgIWV4dHJhTWFza1tpZHhdKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlICE9PSBudWxsICYmIHZhbHVlICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBtYXNrW01hdGguZmxvb3IoaWR4IC8gOCldIHw9IDEgPDwgKGlkeCAlIDgpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgICAgIHJldHVybiBtYXNrO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGVuY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyLCBkYXRhLCBtYXNrcykge1xyXG4gICAgICAgICAgICB2YXIgbWFzayA9IG1hc2tBcnJheShkYXRhLCBtYXNrcyk7XHJcblxyXG4gICAgICAgICAgICBtYXNrSGFuZGxlci5lbmNvZGUoc2VyaWFsaXplciwgbWFzayk7XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIGlmIChoYXNCaXQobWFzaywgaWR4KSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkLmVuY29kZShzZXJpYWxpemVyLCBkYXRhW2lkeF0sIG1hc2tzICYmIG1hc2tzW2lkeF0pO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBkZWNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgICAgICB2YXIgbWFzayA9IG1hc2tIYW5kbGVyLmRlY29kZShzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoY2hpbGQsIGlkeCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGhhc0JpdChtYXNrLCBpZHgpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmRlY29kZShzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBlbXB0eSA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBjaGlsZC5lbXB0eSgpO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBmdWxsTWFzayA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCwgaWR4KSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgdmFsdWUgPSBjaGlsZC5mdWxsTWFzaygpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2lkeF0gPSB2YWx1ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJlc3VsdC5NQVNLID0gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBieXRlQ291bnQgPSBjaGlsZHJlbi5yZWR1Y2UoZnVuY3Rpb24gKGFjY3VtLCBjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gYWNjdW0gKyBjaGlsZC5ieXRlQ291bnQ7XHJcbiAgICAgICAgfSwgbWFza0J5dGVzKTtcclxuICAgICAgICB2YXIgY2hpbGREZXNjcmlwdG9ycyA9IGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmRlc2NyaXB0b3I7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdmFyIGRlc2NyaXB0b3IgPSAnKC8nICsgKG1hc2tCeXRlcyAqIDgpICsgJy8nICsgY2hpbGREZXNjcmlwdG9ycy5qb2luKCcsJykgKyAnKSc7XHJcbiAgICAgICAgcmV0dXJuIG5ldyBIYW5kbGVyKGRlc2NyaXB0b3IsIGJ5dGVDb3VudCwgZW1wdHksIGVuY29kZSwgZGVjb2RlLCBmdWxsTWFzaywgbWFza0FycmF5KTtcclxuICAgIH07XHJcblxyXG4gICAgaGFuZGxlcnMubWFwVW5tYXNrZWQgPSBmdW5jdGlvbiAoY2hpbGRyZW4pIHtcclxuICAgICAgICB2YXIgZW5jb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEsIG1hc2tzKSB7XHJcbiAgICAgICAgICAgIGlmIChtYXNrcyA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICAgICAgbWFza3MgPSBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICBjaGlsZC5oYW5kbGVyLmVuY29kZShzZXJpYWxpemVyLCBkYXRhW2NoaWxkLmtleV0sIG1hc2tzICYmIG1hc2tzW2NoaWxkLmtleV0pO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBkZWNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0ge307XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICByZXN1bHRbY2hpbGQua2V5XSA9IGNoaWxkLmhhbmRsZXIuZGVjb2RlKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBlbXB0eSA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkLmtleV0gPSBjaGlsZC5oYW5kbGVyLmVtcHR5KCk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGZ1bGxNYXNrID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICB2YXIgbm9uTnVsbENoaWxkID0gZmFsc2U7XHJcbiAgICAgICAgICAgIHZhciByZXN1bHQgPSB7fTtcclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgIHZhciB2YWx1ZSA9IGNoaWxkLmhhbmRsZXIuZnVsbE1hc2soKTtcclxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZSAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgICAgIG5vbk51bGxDaGlsZCA9IHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkLmtleV0gPSB2YWx1ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGlmICghbm9uTnVsbENoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGJ5dGVDb3VudCA9IGNoaWxkcmVuLnJlZHVjZShmdW5jdGlvbiAoYWNjdW0sIGNoaWxkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhY2N1bSArIGNoaWxkLmhhbmRsZXIuYnl0ZUNvdW50O1xyXG4gICAgICAgIH0sIDApO1xyXG4gICAgICAgIHZhciBjaGlsZERlc2NyaXB0b3JzID0gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gY2hpbGQua2V5ICsgJzonICsgY2hpbGQuaGFuZGxlci5kZXNjcmlwdG9yO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHZhciBkZXNjcmlwdG9yID0gJ3snICsgY2hpbGREZXNjcmlwdG9ycy5qb2luKCcsJykgKyAnfSc7XHJcbiAgICAgICAgcmV0dXJuIG5ldyBIYW5kbGVyKGRlc2NyaXB0b3IsIGJ5dGVDb3VudCwgZW1wdHksIGVuY29kZSwgZGVjb2RlLCBmdWxsTWFzayk7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLm1hcE1hc2tlZCA9IGZ1bmN0aW9uIChjaGlsZHJlbiwgbWFza0JpdENvdW50KSB7XHJcbiAgICAgICAgdmFyIG1hc2tCeXRlcyA9IE1hdGguY2VpbChjaGlsZHJlbi5sZW5ndGggLyA4KTtcclxuICAgICAgICBpZiAobWFza0JpdENvdW50KSB7XHJcbiAgICAgICAgICAgIG1hc2tCeXRlcyA9IE1hdGgubWF4KG1hc2tCeXRlcywgTWF0aC5jZWlsKG1hc2tCaXRDb3VudCAvIDgpKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIG1hc2tIYW5kbGVyID0gaGFuZGxlcnMuYXJyYXlVbm1hc2tlZChtYXNrQnl0ZXMsIGhhbmRsZXJzLnU4KTtcclxuICAgICAgICB2YXIgbWFza0FycmF5ID0gZnVuY3Rpb24gKGRhdGEsIG1hc2tzKSB7XHJcbiAgICAgICAgICAgIGlmIChtYXNrcyA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICAgICAgbWFza3MgPSBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHZhciBtYXNrID0gemVyb0FycmF5KG1hc2tCeXRlcyk7XHJcbiAgICAgICAgICAgIHZhciBleHRyYU1hc2sgPSBudWxsO1xyXG4gICAgICAgICAgICBpZiAobWFza3MgJiYgKCdNQVNLJyBpbiBtYXNrcykpIHtcclxuICAgICAgICAgICAgICAgIGV4dHJhTWFzayA9IG1hc2tzLk1BU0s7XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIHZhciB2YWx1ZSA9IGRhdGFbY2hpbGQua2V5XTtcclxuICAgICAgICAgICAgICAgIGlmIChleHRyYU1hc2sgJiYgIWV4dHJhTWFza1tjaGlsZC5rZXldKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlICE9PSBudWxsICYmIHZhbHVlICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBtYXNrW01hdGguZmxvb3IoaWR4IC8gOCldIHw9IDEgPDwgKGlkeCAlIDgpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgICAgIHJldHVybiBtYXNrO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGVuY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyLCBkYXRhLCBtYXNrcykge1xyXG4gICAgICAgICAgICB2YXIgbWFzayA9IG1hc2tBcnJheShkYXRhLCBtYXNrcyk7XHJcblxyXG4gICAgICAgICAgICBtYXNrSGFuZGxlci5lbmNvZGUoc2VyaWFsaXplciwgbWFzayk7XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIGlmIChoYXNCaXQobWFzaywgaWR4KSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkLmhhbmRsZXIuZW5jb2RlKHNlcmlhbGl6ZXIsIGRhdGFbY2hpbGQua2V5XSwgbWFza3MgJiYgbWFza3NbY2hpbGQua2V5XSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGRlY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgICAgIHZhciBtYXNrID0gbWFza0hhbmRsZXIuZGVjb2RlKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0ge307XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIGlmIChoYXNCaXQobWFzaywgaWR4KSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjaGlsZC5rZXldID0gY2hpbGQuaGFuZGxlci5kZWNvZGUoc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGVtcHR5ID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0ge307XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICByZXN1bHRbY2hpbGQua2V5XSA9IGNoaWxkLmhhbmRsZXIuZW1wdHkoKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZnVsbE1hc2sgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHZhciByZXN1bHQgPSB7fTtcclxuICAgICAgICAgICAgdmFyIG1hc2sgPSB7fTtcclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgIHZhciB2YWx1ZSA9IGNoaWxkLmhhbmRsZXIuZnVsbE1hc2soKTtcclxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZSAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjaGlsZC5rZXldID0gdmFsdWU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBtYXNrW2NoaWxkLmtleV0gPSB0cnVlO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmVzdWx0Lk1BU0sgPSBtYXNrO1xyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGJ5dGVDb3VudCA9IGNoaWxkcmVuLnJlZHVjZShmdW5jdGlvbiAoYWNjdW0sIGNoaWxkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhY2N1bSArIGNoaWxkLmhhbmRsZXIuYnl0ZUNvdW50O1xyXG4gICAgICAgIH0sIG1hc2tCeXRlcyk7XHJcbiAgICAgICAgdmFyIGNoaWxkRGVzY3JpcHRvcnMgPSBjaGlsZHJlbi5tYXAoZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjaGlsZC5rZXkgKyAnOicgKyBjaGlsZC5oYW5kbGVyLmRlc2NyaXB0b3I7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdmFyIGRlc2NyaXB0b3IgPSAney8nICsgKG1hc2tCeXRlcyAqIDgpICsgJy8nICsgY2hpbGREZXNjcmlwdG9ycy5qb2luKCcsJykgKyAnfSc7XHJcbiAgICAgICAgcmV0dXJuIG5ldyBIYW5kbGVyKGRlc2NyaXB0b3IsIGJ5dGVDb3VudCwgZW1wdHksIGVuY29kZSwgZGVjb2RlLCBmdWxsTWFzaywgbWFza0FycmF5KTtcclxuICAgIH07XHJcblxyXG4gICAgaWYgKCFnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24pIHtcclxuICAgICAgICBnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24gPSB7fTtcclxuICAgIH1cclxuICAgIGdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbi5faGFuZGxlcnMgPSBoYW5kbGVycztcclxuXHJcbn0odGhpcykpO1xyXG4iLCIoZnVuY3Rpb24gKGdsb2JhbCkge1xyXG4gICAgJ3VzZSBzdHJpY3QnO1xyXG5cclxuICAgIGZ1bmN0aW9uIFN0cmluZ1Rva2VuKHBvc2l0aW9uLCB2YWx1ZSkge1xyXG4gICAgICAgIHRoaXMucG9zaXRpb24gPSBwb3NpdGlvbjtcclxuICAgICAgICB0aGlzLnZhbHVlID0gdmFsdWU7XHJcbiAgICB9XHJcblxyXG4gICAgdmFyIG51bWVyaWNUZXN0ID0gL15cXGQrJC87XHJcbiAgICB2YXIgbmFtZVRlc3QgPSAvXlxcdyskLztcclxuXHJcbiAgICB2YXIgVG9rZW5DYXRlZ29yaWVzID0ge1xyXG4gICAgICAgIFNZTUJPTDogMCxcclxuICAgICAgICBOVU1CRVI6IDEsXHJcbiAgICAgICAgTkFNRTogMixcclxuICAgIH07XHJcblxyXG4gICAgZnVuY3Rpb24gVG9rZW4oc3RyaW5nVG9rZW4pIHtcclxuICAgICAgICB0aGlzLnBvc2l0aW9uID0gc3RyaW5nVG9rZW4ucG9zaXRpb247XHJcbiAgICAgICAgdGhpcy52YWx1ZSA9IHN0cmluZ1Rva2VuLnZhbHVlO1xyXG4gICAgICAgIGlmIChudW1lcmljVGVzdC50ZXN0KHRoaXMudmFsdWUpKSB7XHJcbiAgICAgICAgICAgIHRoaXMuY2F0ZWdvcnkgPSBUb2tlbkNhdGVnb3JpZXMuTlVNQkVSO1xyXG4gICAgICAgICAgICB0aGlzLnZhbHVlID0gcGFyc2VJbnQodGhpcy52YWx1ZSk7XHJcbiAgICAgICAgfSBlbHNlIGlmIChuYW1lVGVzdC50ZXN0KHRoaXMudmFsdWUpKSB7XHJcbiAgICAgICAgICAgIHRoaXMuY2F0ZWdvcnkgPSBUb2tlbkNhdGVnb3JpZXMuTkFNRTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICB0aGlzLmNhdGVnb3J5ID0gVG9rZW5DYXRlZ29yaWVzLlNZTUJPTDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgdmFyIHZhbGlkQ2hhclNldFRlc3QgPSAvXlt7fVxcW1xcXSgpXFwvPTosO1xcd1xcc10qJC87XHJcblxyXG4gICAgdmFyIGlzVmFsaWQgPSBmdW5jdGlvbiAodGV4dCkge1xyXG4gICAgICAgIHJldHVybiB2YWxpZENoYXJTZXRUZXN0LnRlc3QodGV4dCk7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciB0b2tlbml6ZXIgPSBmdW5jdGlvbiAodGV4dCkge1xyXG4gICAgICAgIGlmICghaXNWYWxpZCh0ZXh0KSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Bhc3NlZCBjb25maWcgY29udGFpbnMgaW52YWxpZCBjaGFyYWN0ZXJzJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHZhciByZSA9IC8oW3t9XFxbXFxdKClcXC89Oiw7XXxcXHcrKS9nO1xyXG4gICAgICAgIHZhciBtYXRjaDtcclxuICAgICAgICB2YXIgbWF0Y2hlcyA9IFtdO1xyXG4gICAgICAgIHdoaWxlICgobWF0Y2ggPSByZS5leGVjKHRleHQpKSAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICBtYXRjaGVzLnB1c2gobmV3IFN0cmluZ1Rva2VuKG1hdGNoLmluZGV4LCBtYXRjaFswXSkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbWF0Y2hlcztcclxuICAgIH07XHJcblxyXG4gICAgdmFyIGxleGVyID0gZnVuY3Rpb24gKHRva2Vucykge1xyXG4gICAgICAgIHJldHVybiB0b2tlbnMubWFwKGZ1bmN0aW9uICh0b2tlbikge1xyXG4gICAgICAgICAgICByZXR1cm4gbmV3IFRva2VuKHRva2VuKTtcclxuICAgICAgICB9KTtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIFR5cGVDYXRlZ29yaWVzID0ge1xyXG4gICAgICAgIE5BTUVEOiAwLFxyXG4gICAgICAgIE1BUF9VTk1BU0tFRDogMixcclxuICAgICAgICBNQVBfTUFTS0VEOiAzLFxyXG4gICAgICAgIFRVUExFX1VOTUFTS0VEOiA0LFxyXG4gICAgICAgIFRVUExFX01BU0tFRDogNSxcclxuICAgICAgICBBUlJBWV9VTk1BU0tFRDogNixcclxuICAgICAgICBBUlJBWV9NQVNLRUQ6IDcsXHJcbiAgICB9O1xyXG5cclxuICAgIGZ1bmN0aW9uIFR5cGUoY2F0ZWdvcnksIHByb3BlcnRpZXMsIG1hc2spIHtcclxuICAgICAgICB0aGlzLmNhdGVnb3J5ID0gY2F0ZWdvcnk7XHJcbiAgICAgICAgdGhpcy5wcm9wZXJ0aWVzID0gcHJvcGVydGllcztcclxuICAgICAgICB0aGlzLm1hc2sgPSBtYXNrIHx8IDA7XHJcbiAgICB9XHJcblxyXG4gICAgVHlwZS5wcm90b3R5cGUuZ2VuZXJhdGVIYW5kbGVyID0gZnVuY3Rpb24gKGxpYnJhcnkpIHtcclxuICAgICAgICB2YXIgaGFuZGxlcnMgPSBnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24uX2hhbmRsZXJzO1xyXG4gICAgICAgIHZhciBwcm9wcyA9IHRoaXMucHJvcGVydGllcztcclxuICAgICAgICB2YXIgbWFzayA9IHRoaXMubWFzaztcclxuICAgICAgICB2YXIgaGFuZGxlciA9IG51bGw7XHJcbiAgICAgICAgdmFyIGNoaWxkcmVuO1xyXG4gICAgICAgIHN3aXRjaCAodGhpcy5jYXRlZ29yeSkge1xyXG4gICAgICAgICAgICBjYXNlIFR5cGVDYXRlZ29yaWVzLk5BTUVEOlxyXG4gICAgICAgICAgICAgICAgaWYgKHByb3BzIGluIGhhbmRsZXJzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaGFuZGxlciA9IGhhbmRsZXJzW3Byb3BzXTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoIWhhbmRsZXIuaXNCYXNpYykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBoYW5kbGVyID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzWzBdID09PSAncycpIHtcclxuICAgICAgICAgICAgICAgICAgICB2YXIgbGVuZ3RoID0gcHJvcHMuc3Vic3RyaW5nKDEpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChudW1lcmljVGVzdC50ZXN0KGxlbmd0aCkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaGFuZGxlciA9IGhhbmRsZXJzLnN0cmluZyhwYXJzZUludChsZW5ndGgpKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzIGluIGxpYnJhcnkpIHtcclxuICAgICAgICAgICAgICAgICAgICBoYW5kbGVyID0gbGlicmFyeVtwcm9wc107XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoIWhhbmRsZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiAtMSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZXJyb3I6ICdVbnJlY29nbml6ZWQgdHlwZSBcIicgKyBwcm9wcyArICdcIicsXHJcbiAgICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJldHVybiBoYW5kbGVyO1xyXG4gICAgICAgICAgICBjYXNlIFR5cGVDYXRlZ29yaWVzLk1BUF9VTk1BU0tFRDpcclxuICAgICAgICAgICAgICAgIGNoaWxkcmVuID0gcHJvcHMubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY2hpbGQubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgaGFuZGxlcjogY2hpbGQudmFsdWUuZ2VuZXJhdGVIYW5kbGVyKGxpYnJhcnkpLFxyXG4gICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIHJldHVybiBoYW5kbGVycy5tYXBVbm1hc2tlZChjaGlsZHJlbik7XHJcbiAgICAgICAgICAgIGNhc2UgVHlwZUNhdGVnb3JpZXMuTUFQX01BU0tFRDpcclxuICAgICAgICAgICAgICAgIGNoaWxkcmVuID0gcHJvcHMubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY2hpbGQubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgaGFuZGxlcjogY2hpbGQudmFsdWUuZ2VuZXJhdGVIYW5kbGVyKGxpYnJhcnkpLFxyXG4gICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIHJldHVybiBoYW5kbGVycy5tYXBNYXNrZWQoY2hpbGRyZW4sIG1hc2spO1xyXG4gICAgICAgICAgICBjYXNlIFR5cGVDYXRlZ29yaWVzLlRVUExFX1VOTUFTS0VEOlxyXG4gICAgICAgICAgICAgICAgY2hpbGRyZW4gPSBwcm9wcy5tYXAoZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmdlbmVyYXRlSGFuZGxlcihsaWJyYXJ5KTtcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZXJzLnR1cGxlVW5tYXNrZWQoY2hpbGRyZW4pO1xyXG4gICAgICAgICAgICBjYXNlIFR5cGVDYXRlZ29yaWVzLlRVUExFX01BU0tFRDpcclxuICAgICAgICAgICAgICAgIGNoaWxkcmVuID0gcHJvcHMubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBjaGlsZC5nZW5lcmF0ZUhhbmRsZXIobGlicmFyeSk7XHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIHJldHVybiBoYW5kbGVycy50dXBsZU1hc2tlZChjaGlsZHJlbiwgbWFzayk7XHJcbiAgICAgICAgICAgIGNhc2UgVHlwZUNhdGVnb3JpZXMuQVJSQVlfVU5NQVNLRUQ6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlcnMuYXJyYXlVbm1hc2tlZChwcm9wcy5jb3VudCwgcHJvcHMudmFsdWUuZ2VuZXJhdGVIYW5kbGVyKGxpYnJhcnkpKTtcclxuICAgICAgICAgICAgY2FzZSBUeXBlQ2F0ZWdvcmllcy5BUlJBWV9NQVNLRUQ6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlcnMuYXJyYXlNYXNrZWQocHJvcHMuY291bnQsIHByb3BzLnZhbHVlLmdlbmVyYXRlSGFuZGxlcihsaWJyYXJ5KSwgbWFzayk7XHJcbiAgICAgICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiAnVW5yZWNvZ25pemVkIHR5cGUgY2F0ZWdvcnknLFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciByZWFkVG9rZW4gPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIHZhciB0b2tlbiA9IHNlcmlhbGl6ZXIuZGF0YVZpZXdbc2VyaWFsaXplci5pbmRleF07XHJcbiAgICAgICAgc2VyaWFsaXplci5hZGQoMSk7XHJcbiAgICAgICAgaWYgKCF0b2tlbikge1xyXG4gICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogLTEsXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogJ1VuZXhwZWN0ZWQgZW5kIG9mIHN0cmluZycsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0b2tlbjtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIG5hbWVQYXJzZXIgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIHZhciB0b2tlbiA9IHJlYWRUb2tlbihzZXJpYWxpemVyKTtcclxuICAgICAgICBpZiAodG9rZW4uY2F0ZWdvcnkgIT09IFRva2VuQ2F0ZWdvcmllcy5OQU1FKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnRXhwZWN0ZWQgbmFtZSwgZ290OiBcIicgKyB0b2tlbi52YWx1ZSArICdcIicsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSA9PT0gJ01BU0snKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnRGlzYWxsb3dlZCBuYW1lIFwiTUFTS1wiIGdpdmVuJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHRva2VuLnZhbHVlO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgbnVtYmVyUGFyc2VyID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICB2YXIgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgaWYgKHRva2VuLmNhdGVnb3J5ICE9PSBUb2tlbkNhdGVnb3JpZXMuTlVNQkVSKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnRXhwZWN0ZWQgbnVtYmVyLCBnb3Q6IFwiJyArIHRva2VuLnZhbHVlICsgJ1wiJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHRva2VuLnZhbHVlO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgY29uc3VtZVN5bWJvbCA9IGZ1bmN0aW9uIChzZXJpYWxpemVyLCBzeW1ib2wpIHtcclxuICAgICAgICB2YXIgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgaWYgKHRva2VuLnZhbHVlICE9PSBzeW1ib2wpIHtcclxuICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6ICdFeHBlY3RlZCBcIicgKyBzeW1ib2wgKyAnXCIsIGdvdDogXCInICsgdG9rZW4udmFsdWUgKyAnXCInLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgdmFyIG1hc2tQYXJzZXIgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIC8vIFwiLy9cIiBvciBcIi88TlVNQkVSPi9cIiwgb3RoZXJ3aXNlIHRoZXJlIGlzIG5vIG1hc2tcclxuICAgICAgICAvLyBMYWJlbGVkIHdpdGggPE1BU0s+IGluIGNvbW1lbnRzIGJlbG93XHJcbiAgICAgICAgdmFyIHRva2VuID0gcmVhZFRva2VuKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSAhPT0gJy8nKSB7XHJcbiAgICAgICAgICAgIHNlcmlhbGl6ZXIuYWRkKC0xKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIG1hc2tlZDogZmFsc2UsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRva2VuID0gcmVhZFRva2VuKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSA9PT0gJy8nKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBtYXNrZWQ6IHRydWUsXHJcbiAgICAgICAgICAgICAgICBkZWZpbmVkOiBmYWxzZSxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRva2VuLmNhdGVnb3J5ICE9PSBUb2tlbkNhdGVnb3JpZXMuTlVNQkVSKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnRXhwZWN0ZWQgXCIvXCIgb3IgbnVtYmVyJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIHZhbHVlID0gdG9rZW4udmFsdWU7XHJcbiAgICAgICAgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgaWYgKHRva2VuLnZhbHVlICE9PSAnLycpIHtcclxuICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6ICdFeHBlY3RlZCBcIi9cIicsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIG1hc2tlZDogdHJ1ZSxcclxuICAgICAgICAgICAgZGVmaW5lZDogdHJ1ZSxcclxuICAgICAgICAgICAgdmFsdWU6IHZhbHVlLFxyXG4gICAgICAgIH07XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciB0eXBlTWFwUGFyc2VyID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAvLyB7PE1BU0s+IDxOQU1FPjo8VFlQRT4sIDxOQU1FPjo8VFlQRT4sIDxOQU1FPjo8VFlQRT59XHJcbiAgICAgICAgdmFyIG1hc2sgPSBtYXNrUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIHZhciBjaGlsZHJlbiA9IFtdO1xyXG4gICAgICAgIHdoaWxlICh0cnVlKSB7XHJcbiAgICAgICAgICAgIHZhciBuYW1lID0gbmFtZVBhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgY29uc3VtZVN5bWJvbChzZXJpYWxpemVyLCAnOicpO1xyXG4gICAgICAgICAgICB2YXIgdmFsdWUgPSB0eXBlUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5wdXNoKHtcclxuICAgICAgICAgICAgICAgIG5hbWU6IG5hbWUsXHJcbiAgICAgICAgICAgICAgICB2YWx1ZTogdmFsdWUsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB2YXIgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgIGlmICh0b2tlbi52YWx1ZSA9PT0gJ30nKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAobWFzay5tYXNrZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAobWFzay5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgVHlwZShUeXBlQ2F0ZWdvcmllcy5NQVBfTUFTS0VELCBjaGlsZHJlbiwgbWFzay52YWx1ZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLk1BUF9NQVNLRUQsIGNoaWxkcmVuKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgVHlwZShUeXBlQ2F0ZWdvcmllcy5NQVBfVU5NQVNLRUQsIGNoaWxkcmVuKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAodG9rZW4udmFsdWUgIT09ICcsJykge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgICAgICBlcnJvcjogJ1VuZXhwZWN0ZWQgdG9rZW4gYWZ0ZXIgbWFwIGVsZW1lbnQ6IFwiJyArIHRva2VuLnZhbHVlICsgJ1wiJyxcclxuICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciB0eXBlVHVwbGVQYXJzZXIgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIC8vICg8TUFTSz4gPFRZUEU+LCA8VFlQRT4sIDxUWVBFPilcclxuICAgICAgICB2YXIgbWFzayA9IG1hc2tQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgdmFyIGNoaWxkcmVuID0gW107XHJcbiAgICAgICAgd2hpbGUgKHRydWUpIHtcclxuICAgICAgICAgICAgY2hpbGRyZW4ucHVzaCh0eXBlUGFyc2VyKHNlcmlhbGl6ZXIpKTtcclxuICAgICAgICAgICAgdmFyIHRva2VuID0gcmVhZFRva2VuKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICBpZiAodG9rZW4udmFsdWUgPT09ICcpJykge1xyXG4gICAgICAgICAgICAgICAgaWYgKG1hc2subWFza2VkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hc2suZGVmaW5lZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFR5cGUoVHlwZUNhdGVnb3JpZXMuVFVQTEVfTUFTS0VELCBjaGlsZHJlbiwgbWFzay52YWx1ZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLlRVUExFX01BU0tFRCwgY2hpbGRyZW4pO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLlRVUExFX1VOTUFTS0VELCBjaGlsZHJlbik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHRva2VuLnZhbHVlICE9PSAnLCcpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogdG9rZW4ucG9zaXRpb24sXHJcbiAgICAgICAgICAgICAgICAgICAgZXJyb3I6ICdVbmV4cGVjdGVkIHRva2VuIGFmdGVyIHR1cGxlIGVsZW1lbnQ6IFwiJyArIHRva2VuLnZhbHVlICsgJ1wiJyxcclxuICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciB0eXBlQXJyYXlQYXJzZXIgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIC8vIFs8TUFTSz4gPFRZUEU+OjxOVU1CRVI+XVxyXG4gICAgICAgIHZhciBtYXNrID0gbWFza1BhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICB2YXIgdmFsdWUgPSB0eXBlUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIGNvbnN1bWVTeW1ib2woc2VyaWFsaXplciwgJzonKTtcclxuICAgICAgICB2YXIgY291bnQgPSBudW1iZXJQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgY29uc3VtZVN5bWJvbChzZXJpYWxpemVyLCAnXScpO1xyXG4gICAgICAgIHZhciBjaGlsZHJlbiA9IHtcclxuICAgICAgICAgICAgdmFsdWU6IHZhbHVlLFxyXG4gICAgICAgICAgICBjb3VudDogY291bnQsXHJcbiAgICAgICAgfTtcclxuICAgICAgICBpZiAobWFzay5tYXNrZWQpIHtcclxuICAgICAgICAgICAgaWYgKG1hc2suZGVmaW5lZCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLkFSUkFZX01BU0tFRCwgY2hpbGRyZW4sIG1hc2sudmFsdWUpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLkFSUkFZX01BU0tFRCwgY2hpbGRyZW4pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLkFSUkFZX1VOTUFTS0VELCBjaGlsZHJlbik7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgdHlwZVBhcnNlciA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgLy8gT3B0aW9uczpcclxuICAgICAgICAvLyAtIDxOQU1FPlxyXG4gICAgICAgIC8vIC0gVHVwbGVcclxuICAgICAgICAvLyAtIEFycmF5XHJcbiAgICAgICAgLy8gLSBNYXBcclxuICAgICAgICB2YXIgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgaWYgKCF0b2tlbikge1xyXG4gICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogLTEsXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogJ1VuZXhwZWN0ZWQgZW5kIG9mIHN0cmluZycsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0b2tlbi5jYXRlZ29yeSA9PT0gVG9rZW5DYXRlZ29yaWVzLk5VTUJFUikge1xyXG4gICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogdG9rZW4ucG9zaXRpb24sXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogJ1VuZXhwZWN0ZWQgbnVtYmVyLCB0eXBlIGV4cGVjdGVkJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRva2VuLmNhdGVnb3J5ID09PSBUb2tlbkNhdGVnb3JpZXMuTkFNRSkge1xyXG4gICAgICAgICAgICByZXR1cm4gbmV3IFR5cGUoVHlwZUNhdGVnb3JpZXMuTkFNRUQsIHRva2VuLnZhbHVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRva2VuLnZhbHVlID09PSAneycpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHR5cGVNYXBQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSA9PT0gJ1snKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB0eXBlQXJyYXlQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSA9PT0gJygnKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB0eXBlVHVwbGVQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICBlcnJvcjogJ1VuZXhwZWN0ZWQgdG9rZW4gd2hlbiBkZXNjcmliaW5nIHR5cGU6IFwiJyArIHRva2VuLnZhbHVlICsgJ1wiJyxcclxuICAgICAgICB9O1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgcGFyc2VyID0gZnVuY3Rpb24gKHRva2Vucywgc291cmNlKSB7XHJcbiAgICAgICAgdmFyIHNlcmlhbGl6ZXIgPSBuZXcgZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uLlNlcmlhbGl6ZXIodG9rZW5zKTtcclxuICAgICAgICB2YXIgc3RydWN0dXJlcyA9IFtdO1xyXG4gICAgICAgIHdoaWxlIChzZXJpYWxpemVyLmluZGV4IDwgc2VyaWFsaXplci5kYXRhVmlldy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgdmFyIG5hbWUgPSBuYW1lUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICBpZiAobmFtZVswXSAhPT0gbmFtZVswXS50b1VwcGVyQ2FzZSgpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiAnU3RydWN0dXJlIG5hbWVzIGNhbm5vdCBzdGFydCB3aXRoIGxvd2VyY2FzZSBsZXR0ZXJzJyxcclxuICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3VtZVN5bWJvbChzZXJpYWxpemVyLCAnPScpO1xyXG4gICAgICAgICAgICB2YXIgdmFsdWUgPSB0eXBlUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICBjb25zdW1lU3ltYm9sKHNlcmlhbGl6ZXIsICc7Jyk7XHJcbiAgICAgICAgICAgIHN0cnVjdHVyZXMucHVzaCh7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiBuYW1lLFxyXG4gICAgICAgICAgICAgICAgdmFsdWU6IHZhbHVlLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHN0cnVjdHVyZXM7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBjcmVhdGVIYW5kbGVycyA9IGZ1bmN0aW9uIChzdHJ1Y3R1cmUpIHtcclxuICAgICAgICB2YXIgbGlicmFyeSA9IHt9O1xyXG4gICAgICAgIHN0cnVjdHVyZS5mb3JFYWNoKGZ1bmN0aW9uIChlbnRyeSkge1xyXG4gICAgICAgICAgICBsaWJyYXJ5W2VudHJ5Lm5hbWVdID0gZW50cnkudmFsdWUuZ2VuZXJhdGVIYW5kbGVyKGxpYnJhcnkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJldHVybiBsaWJyYXJ5O1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgcGFyc2UgPSBmdW5jdGlvbiAodGV4dCkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjcmVhdGVIYW5kbGVycyhwYXJzZXIobGV4ZXIodG9rZW5pemVyKHRleHQpLCB0ZXh0KSwgdGV4dCkpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoZXJyLmVycm9yKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGlmICghZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uKSB7XHJcbiAgICAgICAgZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uID0ge307XHJcbiAgICB9XHJcblxyXG4gICAgZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uLl9wYXJzZXJTdGVwcyA9IHtcclxuICAgICAgICB0b2tlbml6ZXI6IHRva2VuaXplcixcclxuICAgICAgICBsZXhlcjogbGV4ZXIsXHJcbiAgICAgICAgcGFyc2VyOiBwYXJzZXIsXHJcbiAgICAgICAgVG9rZW5DYXRlZ29yaWVzOiBUb2tlbkNhdGVnb3JpZXMsXHJcbiAgICAgICAgVHlwZUNhdGVnb3JpZXM6IFR5cGVDYXRlZ29yaWVzLFxyXG4gICAgICAgIFN0cmluZ1Rva2VuOiBTdHJpbmdUb2tlbixcclxuICAgICAgICBUb2tlbjogVG9rZW4sXHJcbiAgICAgICAgVHlwZTogVHlwZSxcclxuICAgIH07XHJcblxyXG4gICAgZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uLnBhcnNlID0gcGFyc2U7XHJcblxyXG59KHRoaXMpKTtcclxuIiwiKGZ1bmN0aW9uIChnbG9iYWwpIHtcclxuICAgICd1c2Ugc3RyaWN0JztcclxuXHJcbiAgICBmdW5jdGlvbiBTZXJpYWxpemVyKGRhdGFWaWV3KSB7XHJcbiAgICAgICAgdGhpcy5pbmRleCA9IDA7XHJcbiAgICAgICAgdGhpcy5kYXRhVmlldyA9IGRhdGFWaWV3O1xyXG4gICAgfVxyXG5cclxuICAgIFNlcmlhbGl6ZXIucHJvdG90eXBlLmFkZCA9IGZ1bmN0aW9uIChpbmNyZW1lbnQpIHtcclxuICAgICAgICB0aGlzLmluZGV4ICs9IGluY3JlbWVudDtcclxuICAgIH07XHJcblxyXG4gICAgaWYgKCFnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24pIHtcclxuICAgICAgICBnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24gPSB7fTtcclxuICAgIH1cclxuICAgIGdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbi5TZXJpYWxpemVyID0gU2VyaWFsaXplcjtcclxuXHJcbn0odGhpcykpO1xyXG4iXX0=
