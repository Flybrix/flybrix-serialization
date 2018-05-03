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

    function Handler(descriptor, byteCount, empty, encode, decode, fullMask) {
        this.descriptor = descriptor;
        this.byteCount = byteCount;
        this.encode = encode;
        this.decode = decode;
        this.empty = empty;
        this.fullMask = fullMask || nullMask;
        this.isBasic = false;
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
        var encode = function (serializer, data, masks) {
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

            maskHandler.encode(serializer, mask);
            children.forEach(function (child, idx) {
                if (hasBit(mask, idx)) {
                    child.encode(serializer, data[idx], masks && masks[idx]);
                }
            });
        };
        var decode = function (serializer) {
            var mask = maskHandler.decode(serializer);
            var result = children.map(function (child, idx) {
                if (hasBit(mask, idx)) {
                    return child.decode(serializer);
                }
                return null;
            });
            return result;
        };
        var empty = function () {
            var result = children.map(function (child) {
                return child.empty();
            });
            return result;
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
        return new Handler(descriptor, byteCount, empty, encode, decode, fullMask);
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
        var encode = function (serializer, data, masks) {
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
                } else {
                    result[child.key] = null;
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
        return new Handler(descriptor, byteCount, empty, encode, decode, fullMask);
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

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1vZHVsZS5qcyIsImhhbmRsZXJzLmpzIiwicGFyc2VyLmpzIiwic2VyaWFsaXplci5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FDVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FDbmFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUNoWkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZmx5YnJpeC1zZXJpYWxpemF0aW9uLmpzIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uICgpIHtcclxuICAgICd1c2Ugc3RyaWN0JztcclxuXHJcbiAgICBhbmd1bGFyLm1vZHVsZSgnZmx5YnJpeFNlcmlhbGl6YXRpb24nLCBbXSkuZmFjdG9yeSgnZmJTZXJpYWxpemVyJywgZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIFNlcmlhbGl6ZXI6IEZseWJyaXhTZXJpYWxpemF0aW9uLlNlcmlhbGl6ZXIsXHJcbiAgICAgICAgICAgIGNyZWF0ZUhhbmRsZXI6IEZseWJyaXhTZXJpYWxpemF0aW9uLnBhcnNlLFxyXG4gICAgICAgIH07XHJcbiAgICB9KTtcclxufSk7XHJcbiIsIihmdW5jdGlvbiAoZ2xvYmFsKSB7XHJcbiAgICAndXNlIHN0cmljdCc7XHJcblxyXG4gICAgdmFyIG51bGxNYXNrID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfTtcclxuXHJcbiAgICBmdW5jdGlvbiBIYW5kbGVyKGRlc2NyaXB0b3IsIGJ5dGVDb3VudCwgZW1wdHksIGVuY29kZSwgZGVjb2RlLCBmdWxsTWFzaykge1xyXG4gICAgICAgIHRoaXMuZGVzY3JpcHRvciA9IGRlc2NyaXB0b3I7XHJcbiAgICAgICAgdGhpcy5ieXRlQ291bnQgPSBieXRlQ291bnQ7XHJcbiAgICAgICAgdGhpcy5lbmNvZGUgPSBlbmNvZGU7XHJcbiAgICAgICAgdGhpcy5kZWNvZGUgPSBkZWNvZGU7XHJcbiAgICAgICAgdGhpcy5lbXB0eSA9IGVtcHR5O1xyXG4gICAgICAgIHRoaXMuZnVsbE1hc2sgPSBmdWxsTWFzayB8fCBudWxsTWFzaztcclxuICAgICAgICB0aGlzLmlzQmFzaWMgPSBmYWxzZTtcclxuICAgIH1cclxuXHJcbiAgICB2YXIgaGFuZGxlcnMgPSB7fTtcclxuXHJcbiAgICB2YXIgaGFzQml0ID0gZnVuY3Rpb24gKG1hc2ssIGlkeCkge1xyXG4gICAgICAgIHJldHVybiAobWFza1tNYXRoLmZsb29yKGlkeCAvIDgpXSAmICgxIDw8IChpZHggJSA4KSkpICE9PSAwO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgZW1wdHlOdW1lcmljID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIHJldHVybiAwO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgemVyb0FycmF5ID0gZnVuY3Rpb24gKGwpIHtcclxuICAgICAgICB2YXIgcmVzdWx0ID0gW107XHJcbiAgICAgICAgZm9yICh2YXIgaWR4ID0gMDsgaWR4IDwgbDsgKytpZHgpIHtcclxuICAgICAgICAgICAgcmVzdWx0LnB1c2goMCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBjcmVhdGVOdW1lcmljVHlwZSA9IGZ1bmN0aW9uIChrZXlTaG9ydCwga2V5LCBieXRlQ291bnQpIHtcclxuICAgICAgICB2YXIgZW5jb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEpIHtcclxuICAgICAgICAgICAgc2VyaWFsaXplci5kYXRhVmlld1snc2V0JyArIGtleV0oc2VyaWFsaXplci5pbmRleCwgZGF0YSwgMSk7XHJcbiAgICAgICAgICAgIHNlcmlhbGl6ZXIuYWRkKGJ5dGVDb3VudCk7XHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgdmFyIGRlY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgICAgIHZhciBkYXRhID0gc2VyaWFsaXplci5kYXRhVmlld1snZ2V0JyArIGtleV0oc2VyaWFsaXplci5pbmRleCwgMSk7XHJcbiAgICAgICAgICAgIHNlcmlhbGl6ZXIuYWRkKGJ5dGVDb3VudCk7XHJcbiAgICAgICAgICAgIHJldHVybiBkYXRhO1xyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIHZhciBoYW5kbGVyID0gbmV3IEhhbmRsZXIoa2V5U2hvcnQsIGJ5dGVDb3VudCwgZW1wdHlOdW1lcmljLCBlbmNvZGUsIGRlY29kZSk7XHJcblxyXG4gICAgICAgIGhhbmRsZXIuaXNCYXNpYyA9IHRydWU7XHJcblxyXG4gICAgICAgIHJldHVybiBoYW5kbGVyO1xyXG4gICAgfTtcclxuXHJcbiAgICBoYW5kbGVycy51OCA9IGNyZWF0ZU51bWVyaWNUeXBlKCd1OCcsICdVaW50OCcsIDEpO1xyXG4gICAgaGFuZGxlcnMudTE2ID0gY3JlYXRlTnVtZXJpY1R5cGUoJ3UxNicsICdVaW50MTYnLCAyKTtcclxuICAgIGhhbmRsZXJzLnUzMiA9IGNyZWF0ZU51bWVyaWNUeXBlKCd1MzInLCAnVWludDMyJywgNCk7XHJcbiAgICBoYW5kbGVycy5pOCA9IGNyZWF0ZU51bWVyaWNUeXBlKCdpOCcsICdJbnQ4JywgMSk7XHJcbiAgICBoYW5kbGVycy5pMTYgPSBjcmVhdGVOdW1lcmljVHlwZSgnaTE2JywgJ0ludDE2JywgMik7XHJcbiAgICBoYW5kbGVycy5pMzIgPSBjcmVhdGVOdW1lcmljVHlwZSgnaTMyJywgJ0ludDMyJywgNCk7XHJcbiAgICBoYW5kbGVycy5mMzIgPSBjcmVhdGVOdW1lcmljVHlwZSgnZjMyJywgJ0Zsb2F0MzInLCA0KTtcclxuICAgIGhhbmRsZXJzLmY2NCA9IGNyZWF0ZU51bWVyaWNUeXBlKCdmNjQnLCAnRmxvYXQ2NCcsIDgpO1xyXG5cclxuICAgIGhhbmRsZXJzLmJvb2wgPSBuZXcgSGFuZGxlcihcclxuICAgICAgICAnYm9vbCcsXHJcbiAgICAgICAgaGFuZGxlcnMudTguYnl0ZUNvdW50LFxyXG4gICAgICAgIGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIH0sXHJcbiAgICAgICAgZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEpIHtcclxuICAgICAgICAgICAgaGFuZGxlcnMudTguZW5jb2RlKHNlcmlhbGl6ZXIsIGRhdGEgPyAxIDogMCk7XHJcbiAgICAgICAgfSxcclxuICAgICAgICBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgICAgICByZXR1cm4gaGFuZGxlcnMudTguZGVjb2RlKHNlcmlhbGl6ZXIpICE9PSAwO1xyXG4gICAgICAgIH0pO1xyXG4gICAgaGFuZGxlcnMuYm9vbC5pc0Jhc2ljID0gdHJ1ZTtcclxuXHJcbiAgICBoYW5kbGVycy52b2lkID0gbmV3IEhhbmRsZXIoXHJcbiAgICAgICAgJ3ZvaWQnLFxyXG4gICAgICAgIDAsXHJcbiAgICAgICAgZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgICB9LFxyXG4gICAgICAgIGZ1bmN0aW9uIChzZXJpYWxpemVyLCBkYXRhKSB7XHJcbiAgICAgICAgfSxcclxuICAgICAgICBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgIH0pO1xyXG4gICAgaGFuZGxlcnMudm9pZC5pc0Jhc2ljID0gdHJ1ZTtcclxuXHJcbiAgICB2YXIgYXNjaWlFbmNvZGUgPSBmdW5jdGlvbiAobmFtZSwgbGVuZ3RoKSB7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gbmV3IFVpbnQ4QXJyYXkobGVuZ3RoKTtcclxuICAgICAgICBuYW1lLnNwbGl0KCcnKS5mb3JFYWNoKGZ1bmN0aW9uIChjLCBpZHgpIHtcclxuICAgICAgICAgICAgcmVzcG9uc2VbaWR4XSA9IGMuY2hhckNvZGVBdCgwKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXNwb25zZVtsZW5ndGggLSAxXSA9IDA7XHJcbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgYXNjaWlEZWNvZGUgPSBmdW5jdGlvbiAobmFtZSwgbGVuZ3RoKSB7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gJyc7XHJcbiAgICAgICAgdmFyIGwgPSBNYXRoLm1pbihuYW1lLmxlbmd0aCwgbGVuZ3RoIC0gMSk7XHJcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsOyArK2kpIHtcclxuICAgICAgICAgICAgaWYgKG5hbWVbaV0gPT09IDApIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiByZXNwb25zZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXNwb25zZSArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKG5hbWVbaV0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gcmVzcG9uc2U7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLnN0cmluZyA9IGZ1bmN0aW9uIChsZW5ndGgpIHtcclxuICAgICAgICB2YXIgaGFuZGxlciA9IGhhbmRsZXJzLmFycmF5VW5tYXNrZWQobGVuZ3RoLCBoYW5kbGVycy51OCk7XHJcbiAgICAgICAgdmFyIGVuY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyLCBkYXRhKSB7XHJcbiAgICAgICAgICAgIGhhbmRsZXIuZW5jb2RlKHNlcmlhbGl6ZXIsIGFzY2lpRW5jb2RlKGRhdGEsIGxlbmd0aCkpO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGRlY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhc2NpaURlY29kZShoYW5kbGVyLmRlY29kZShzZXJpYWxpemVyKSwgbGVuZ3RoKTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBlbXB0eSA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgcmV0dXJuICcnO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgcmV0dXJuIG5ldyBIYW5kbGVyKCdzJyArIGxlbmd0aCwgbGVuZ3RoLCBlbXB0eSwgZW5jb2RlLCBkZWNvZGUpO1xyXG4gICAgfTtcclxuXHJcbiAgICBoYW5kbGVycy5zID0gbmV3IEhhbmRsZXIoXHJcbiAgICAgICAgJ3MnLFxyXG4gICAgICAgIDAsXHJcbiAgICAgICAgZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICByZXR1cm4gJyc7XHJcbiAgICAgICAgfSxcclxuICAgICAgICBmdW5jdGlvbiAoc2VyaWFsaXplciwgZGF0YSkge1xyXG4gICAgICAgICAgICB2YXIgYnl0ZUNvdW50ID0gTWF0aC5taW4oZGF0YS5sZW5ndGgsIHNlcmlhbGl6ZXIuZGF0YVZpZXcuYnl0ZUxlbmd0aCAtIHNlcmlhbGl6ZXIuaW5kZXgpO1xyXG4gICAgICAgICAgICBmb3IgKHZhciBpZHggPSAwOyBpZHggPCBieXRlQ291bnQ7ICsraWR4KSB7XHJcbiAgICAgICAgICAgICAgICBoYW5kbGVycy51OC5lbmNvZGUoc2VyaWFsaXplciwgZGF0YS5jaGFyQ29kZUF0KGlkeCkpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChzZXJpYWxpemVyLmluZGV4IDwgc2VyaWFsaXplci5kYXRhVmlldy5ieXRlTGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICBoYW5kbGVycy51OC5lbmNvZGUoc2VyaWFsaXplciwgMCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9LFxyXG4gICAgICAgIGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgICAgIHZhciByZXNwb25zZSA9ICcnO1xyXG4gICAgICAgICAgICB2YXIgYnl0ZUNvdW50ID0gc2VyaWFsaXplci5kYXRhVmlldy5ieXRlTGVuZ3RoIC0gc2VyaWFsaXplci5pbmRleDtcclxuICAgICAgICAgICAgd2hpbGUgKGJ5dGVDb3VudC0tID4gMCkge1xyXG4gICAgICAgICAgICAgICAgdmFyIGNoYXJDb2RlID0gaGFuZGxlcnMudTguZGVjb2RlKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFjaGFyQ29kZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZXNwb25zZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJlc3BvbnNlICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoY2hhckNvZGUpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiByZXNwb25zZTtcclxuICAgICAgICB9KTtcclxuICAgIGhhbmRsZXJzLnMuaXNCYXNpYyA9IHRydWU7XHJcblxyXG4gICAgaGFuZGxlcnMuYXJyYXlVbm1hc2tlZCA9IGZ1bmN0aW9uIChsZW5ndGgsIGhhbmRsZXIpIHtcclxuICAgICAgICB2YXIgY2hpbGRyZW4gPSBbXTtcclxuICAgICAgICBmb3IgKHZhciBpZHggPSAwOyBpZHggPCBsZW5ndGg7ICsraWR4KSB7XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLnB1c2goaGFuZGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHZhciByZXN1bHQgPSBoYW5kbGVycy50dXBsZVVubWFza2VkKGNoaWxkcmVuKTtcclxuICAgICAgICByZXN1bHQuZGVzY3JpcHRvciA9ICdbJyArIGhhbmRsZXIuZGVzY3JpcHRvciArICc6JyArIGxlbmd0aCArICddJztcclxuICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgfTtcclxuXHJcbiAgICBoYW5kbGVycy50dXBsZVVubWFza2VkID0gZnVuY3Rpb24gKGNoaWxkcmVuKSB7XHJcbiAgICAgICAgdmFyIGVuY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyLCBkYXRhLCBtYXNrcykge1xyXG4gICAgICAgICAgICBpZiAobWFza3MgPT09IHRydWUpIHtcclxuICAgICAgICAgICAgICAgIG1hc2tzID0gbnVsbDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCwgaWR4KSB7XHJcbiAgICAgICAgICAgICAgICBjaGlsZC5lbmNvZGUoc2VyaWFsaXplciwgZGF0YVtpZHhdLCBtYXNrcyAmJiBtYXNrc1tpZHhdKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZGVjb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBjaGlsZC5kZWNvZGUoc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGVtcHR5ID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICByZXR1cm4gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmVtcHR5KCk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGZ1bGxNYXNrID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICB2YXIgbm9uTnVsbENoaWxkID0gZmFsc2U7XHJcbiAgICAgICAgICAgIHZhciByZXN1bHQgPSB7fTtcclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoY2hpbGQsIGlkeCkge1xyXG4gICAgICAgICAgICAgICAgdmFyIHZhbHVlID0gY2hpbGQuZnVsbE1hc2soKTtcclxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZSAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgICAgIG5vbk51bGxDaGlsZCA9IHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2lkeF0gPSB2YWx1ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGlmICghbm9uTnVsbENoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGJ5dGVDb3VudCA9IGNoaWxkcmVuLnJlZHVjZShmdW5jdGlvbiAoYWNjdW0sIGNoaWxkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhY2N1bSArIGNoaWxkLmJ5dGVDb3VudDtcclxuICAgICAgICB9LCAwKTtcclxuICAgICAgICB2YXIgY2hpbGREZXNjcmlwdG9ycyA9IGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmRlc2NyaXB0b3I7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdmFyIGRlc2NyaXB0b3IgPSAnKCcgKyBjaGlsZERlc2NyaXB0b3JzLmpvaW4oJywnKSArICcpJztcclxuICAgICAgICByZXR1cm4gbmV3IEhhbmRsZXIoZGVzY3JpcHRvciwgYnl0ZUNvdW50LCBlbXB0eSwgZW5jb2RlLCBkZWNvZGUsIGZ1bGxNYXNrKTtcclxuICAgIH07XHJcblxyXG4gICAgaGFuZGxlcnMuYXJyYXlNYXNrZWQgPSBmdW5jdGlvbiAobGVuZ3RoLCBoYW5kbGVyLCBtYXNrQml0Q291bnQpIHtcclxuICAgICAgICB2YXIgY2hpbGRyZW4gPSBbXTtcclxuICAgICAgICBmb3IgKHZhciBpZHggPSAwOyBpZHggPCBsZW5ndGg7ICsraWR4KSB7XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLnB1c2goaGFuZGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHZhciByZXN1bHQgPSBoYW5kbGVycy50dXBsZU1hc2tlZChjaGlsZHJlbiwgbWFza0JpdENvdW50KTtcclxuICAgICAgICB2YXIgbWFza1NpemUgPSAocmVzdWx0LmJ5dGVDb3VudCAtIChsZW5ndGggKiBoYW5kbGVyLmJ5dGVDb3VudCkpICogODtcclxuICAgICAgICByZXN1bHQuZGVzY3JpcHRvciA9ICdbLycgKyBtYXNrU2l6ZSArICcvJyArIGhhbmRsZXIuZGVzY3JpcHRvciArICc6JyArIGxlbmd0aCArICddJztcclxuICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgfTtcclxuXHJcbiAgICBoYW5kbGVycy50dXBsZU1hc2tlZCA9IGZ1bmN0aW9uIChjaGlsZHJlbiwgbWFza0JpdENvdW50KSB7XHJcbiAgICAgICAgdmFyIG1hc2tCeXRlcyA9IE1hdGguY2VpbChjaGlsZHJlbi5sZW5ndGggLyA4KTtcclxuICAgICAgICBpZiAobWFza0JpdENvdW50KSB7XHJcbiAgICAgICAgICAgIG1hc2tCeXRlcyA9IE1hdGgubWF4KG1hc2tCeXRlcywgTWF0aC5jZWlsKG1hc2tCaXRDb3VudCAvIDgpKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIG1hc2tIYW5kbGVyID0gaGFuZGxlcnMuYXJyYXlVbm1hc2tlZChtYXNrQnl0ZXMsIGhhbmRsZXJzLnU4KTtcclxuICAgICAgICB2YXIgZW5jb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEsIG1hc2tzKSB7XHJcbiAgICAgICAgICAgIGlmIChtYXNrcyA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICAgICAgbWFza3MgPSBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHZhciBtYXNrID0gemVyb0FycmF5KG1hc2tCeXRlcyk7XHJcbiAgICAgICAgICAgIHZhciBleHRyYU1hc2sgPSBudWxsO1xyXG4gICAgICAgICAgICBpZiAobWFza3MgJiYgKCdNQVNLJyBpbiBtYXNrcykpIHtcclxuICAgICAgICAgICAgICAgIGV4dHJhTWFzayA9IG1hc2tzLk1BU0s7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoXywgaWR4KSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgdmFsdWUgPSBkYXRhW2lkeF07XHJcbiAgICAgICAgICAgICAgICBpZiAoZXh0cmFNYXNrICYmICFleHRyYU1hc2tbaWR4XSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZSAhPT0gbnVsbCAmJiB2YWx1ZSAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbWFza1tNYXRoLmZsb29yKGlkeCAvIDgpXSB8PSAxIDw8IChpZHggJSA4KTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICBtYXNrSGFuZGxlci5lbmNvZGUoc2VyaWFsaXplciwgbWFzayk7XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIGlmIChoYXNCaXQobWFzaywgaWR4KSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkLmVuY29kZShzZXJpYWxpemVyLCBkYXRhW2lkeF0sIG1hc2tzICYmIG1hc2tzW2lkeF0pO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBkZWNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgICAgICB2YXIgbWFzayA9IG1hc2tIYW5kbGVyLmRlY29kZShzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoY2hpbGQsIGlkeCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGhhc0JpdChtYXNrLCBpZHgpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmRlY29kZShzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBlbXB0eSA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBjaGlsZC5lbXB0eSgpO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBmdWxsTWFzayA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCwgaWR4KSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgdmFsdWUgPSBjaGlsZC5mdWxsTWFzaygpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2lkeF0gPSB2YWx1ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJlc3VsdC5NQVNLID0gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBieXRlQ291bnQgPSBjaGlsZHJlbi5yZWR1Y2UoZnVuY3Rpb24gKGFjY3VtLCBjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gYWNjdW0gKyBjaGlsZC5ieXRlQ291bnQ7XHJcbiAgICAgICAgfSwgbWFza0J5dGVzKTtcclxuICAgICAgICB2YXIgY2hpbGREZXNjcmlwdG9ycyA9IGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmRlc2NyaXB0b3I7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdmFyIGRlc2NyaXB0b3IgPSAnKC8nICsgKG1hc2tCeXRlcyAqIDgpICsgJy8nICsgY2hpbGREZXNjcmlwdG9ycy5qb2luKCcsJykgKyAnKSc7XHJcbiAgICAgICAgcmV0dXJuIG5ldyBIYW5kbGVyKGRlc2NyaXB0b3IsIGJ5dGVDb3VudCwgZW1wdHksIGVuY29kZSwgZGVjb2RlLCBmdWxsTWFzayk7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLm1hcFVubWFza2VkID0gZnVuY3Rpb24gKGNoaWxkcmVuKSB7XHJcbiAgICAgICAgdmFyIGVuY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyLCBkYXRhLCBtYXNrcykge1xyXG4gICAgICAgICAgICBpZiAobWFza3MgPT09IHRydWUpIHtcclxuICAgICAgICAgICAgICAgIG1hc2tzID0gbnVsbDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgY2hpbGQuaGFuZGxlci5lbmNvZGUoc2VyaWFsaXplciwgZGF0YVtjaGlsZC5rZXldLCBtYXNrcyAmJiBtYXNrc1tjaGlsZC5rZXldKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZGVjb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkLmtleV0gPSBjaGlsZC5oYW5kbGVyLmRlY29kZShzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZW1wdHkgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHZhciByZXN1bHQgPSB7fTtcclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgIHJlc3VsdFtjaGlsZC5rZXldID0gY2hpbGQuaGFuZGxlci5lbXB0eSgpO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBmdWxsTWFzayA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgdmFyIG5vbk51bGxDaGlsZCA9IGZhbHNlO1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0ge307XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgdmFsdWUgPSBjaGlsZC5oYW5kbGVyLmZ1bGxNYXNrKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUgIT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgICAgICBub25OdWxsQ2hpbGQgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjaGlsZC5rZXldID0gdmFsdWU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBpZiAoIW5vbk51bGxDaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBieXRlQ291bnQgPSBjaGlsZHJlbi5yZWR1Y2UoZnVuY3Rpb24gKGFjY3VtLCBjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gYWNjdW0gKyBjaGlsZC5oYW5kbGVyLmJ5dGVDb3VudDtcclxuICAgICAgICB9LCAwKTtcclxuICAgICAgICB2YXIgY2hpbGREZXNjcmlwdG9ycyA9IGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmtleSArICc6JyArIGNoaWxkLmhhbmRsZXIuZGVzY3JpcHRvcjtcclxuICAgICAgICB9KTtcclxuICAgICAgICB2YXIgZGVzY3JpcHRvciA9ICd7JyArIGNoaWxkRGVzY3JpcHRvcnMuam9pbignLCcpICsgJ30nO1xyXG4gICAgICAgIHJldHVybiBuZXcgSGFuZGxlcihkZXNjcmlwdG9yLCBieXRlQ291bnQsIGVtcHR5LCBlbmNvZGUsIGRlY29kZSwgZnVsbE1hc2spO1xyXG4gICAgfTtcclxuXHJcbiAgICBoYW5kbGVycy5tYXBNYXNrZWQgPSBmdW5jdGlvbiAoY2hpbGRyZW4sIG1hc2tCaXRDb3VudCkge1xyXG4gICAgICAgIHZhciBtYXNrQnl0ZXMgPSBNYXRoLmNlaWwoY2hpbGRyZW4ubGVuZ3RoIC8gOCk7XHJcbiAgICAgICAgaWYgKG1hc2tCaXRDb3VudCkge1xyXG4gICAgICAgICAgICBtYXNrQnl0ZXMgPSBNYXRoLm1heChtYXNrQnl0ZXMsIE1hdGguY2VpbChtYXNrQml0Q291bnQgLyA4KSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHZhciBtYXNrSGFuZGxlciA9IGhhbmRsZXJzLmFycmF5VW5tYXNrZWQobWFza0J5dGVzLCBoYW5kbGVycy51OCk7XHJcbiAgICAgICAgdmFyIGVuY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyLCBkYXRhLCBtYXNrcykge1xyXG4gICAgICAgICAgICBpZiAobWFza3MgPT09IHRydWUpIHtcclxuICAgICAgICAgICAgICAgIG1hc2tzID0gbnVsbDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB2YXIgbWFzayA9IHplcm9BcnJheShtYXNrQnl0ZXMpO1xyXG4gICAgICAgICAgICB2YXIgZXh0cmFNYXNrID0gbnVsbDtcclxuICAgICAgICAgICAgaWYgKG1hc2tzICYmICgnTUFTSycgaW4gbWFza3MpKSB7XHJcbiAgICAgICAgICAgICAgICBleHRyYU1hc2sgPSBtYXNrcy5NQVNLO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCwgaWR4KSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgdmFsdWUgPSBkYXRhW2NoaWxkLmtleV07XHJcbiAgICAgICAgICAgICAgICBpZiAoZXh0cmFNYXNrICYmICFleHRyYU1hc2tbY2hpbGQua2V5XSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZSAhPT0gbnVsbCAmJiB2YWx1ZSAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbWFza1tNYXRoLmZsb29yKGlkeCAvIDgpXSB8PSAxIDw8IChpZHggJSA4KTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICBtYXNrSGFuZGxlci5lbmNvZGUoc2VyaWFsaXplciwgbWFzayk7XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIGlmIChoYXNCaXQobWFzaywgaWR4KSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkLmhhbmRsZXIuZW5jb2RlKHNlcmlhbGl6ZXIsIGRhdGFbY2hpbGQua2V5XSwgbWFza3MgJiYgbWFza3NbY2hpbGQua2V5XSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGRlY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgICAgIHZhciBtYXNrID0gbWFza0hhbmRsZXIuZGVjb2RlKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0ge307XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIGlmIChoYXNCaXQobWFzaywgaWR4KSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjaGlsZC5rZXldID0gY2hpbGQuaGFuZGxlci5kZWNvZGUoc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjaGlsZC5rZXldID0gbnVsbDtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZW1wdHkgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHZhciByZXN1bHQgPSB7fTtcclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgIHJlc3VsdFtjaGlsZC5rZXldID0gY2hpbGQuaGFuZGxlci5lbXB0eSgpO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBmdWxsTWFzayA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xyXG4gICAgICAgICAgICB2YXIgbWFzayA9IHt9O1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgdmFyIHZhbHVlID0gY2hpbGQuaGFuZGxlci5mdWxsTWFzaygpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkLmtleV0gPSB2YWx1ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIG1hc2tbY2hpbGQua2V5XSA9IHRydWU7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXN1bHQuTUFTSyA9IG1hc2s7XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgYnl0ZUNvdW50ID0gY2hpbGRyZW4ucmVkdWNlKGZ1bmN0aW9uIChhY2N1bSwgY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGFjY3VtICsgY2hpbGQuaGFuZGxlci5ieXRlQ291bnQ7XHJcbiAgICAgICAgfSwgbWFza0J5dGVzKTtcclxuICAgICAgICB2YXIgY2hpbGREZXNjcmlwdG9ycyA9IGNoaWxkcmVuLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmtleSArICc6JyArIGNoaWxkLmhhbmRsZXIuZGVzY3JpcHRvcjtcclxuICAgICAgICB9KTtcclxuICAgICAgICB2YXIgZGVzY3JpcHRvciA9ICd7LycgKyAobWFza0J5dGVzICogOCkgKyAnLycgKyBjaGlsZERlc2NyaXB0b3JzLmpvaW4oJywnKSArICd9JztcclxuICAgICAgICByZXR1cm4gbmV3IEhhbmRsZXIoZGVzY3JpcHRvciwgYnl0ZUNvdW50LCBlbXB0eSwgZW5jb2RlLCBkZWNvZGUsIGZ1bGxNYXNrKTtcclxuICAgIH07XHJcblxyXG4gICAgaWYgKCFnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24pIHtcclxuICAgICAgICBnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24gPSB7fTtcclxuICAgIH1cclxuICAgIGdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbi5faGFuZGxlcnMgPSBoYW5kbGVycztcclxuXHJcbn0odGhpcykpO1xyXG4iLCIoZnVuY3Rpb24gKGdsb2JhbCkge1xyXG4gICAgJ3VzZSBzdHJpY3QnO1xyXG5cclxuICAgIGZ1bmN0aW9uIFN0cmluZ1Rva2VuKHBvc2l0aW9uLCB2YWx1ZSkge1xyXG4gICAgICAgIHRoaXMucG9zaXRpb24gPSBwb3NpdGlvbjtcclxuICAgICAgICB0aGlzLnZhbHVlID0gdmFsdWU7XHJcbiAgICB9XHJcblxyXG4gICAgdmFyIG51bWVyaWNUZXN0ID0gL15cXGQrJC87XHJcbiAgICB2YXIgbmFtZVRlc3QgPSAvXlxcdyskLztcclxuXHJcbiAgICB2YXIgVG9rZW5DYXRlZ29yaWVzID0ge1xyXG4gICAgICAgIFNZTUJPTDogMCxcclxuICAgICAgICBOVU1CRVI6IDEsXHJcbiAgICAgICAgTkFNRTogMixcclxuICAgIH07XHJcblxyXG4gICAgZnVuY3Rpb24gVG9rZW4oc3RyaW5nVG9rZW4pIHtcclxuICAgICAgICB0aGlzLnBvc2l0aW9uID0gc3RyaW5nVG9rZW4ucG9zaXRpb247XHJcbiAgICAgICAgdGhpcy52YWx1ZSA9IHN0cmluZ1Rva2VuLnZhbHVlO1xyXG4gICAgICAgIGlmIChudW1lcmljVGVzdC50ZXN0KHRoaXMudmFsdWUpKSB7XHJcbiAgICAgICAgICAgIHRoaXMuY2F0ZWdvcnkgPSBUb2tlbkNhdGVnb3JpZXMuTlVNQkVSO1xyXG4gICAgICAgICAgICB0aGlzLnZhbHVlID0gcGFyc2VJbnQodGhpcy52YWx1ZSk7XHJcbiAgICAgICAgfSBlbHNlIGlmIChuYW1lVGVzdC50ZXN0KHRoaXMudmFsdWUpKSB7XHJcbiAgICAgICAgICAgIHRoaXMuY2F0ZWdvcnkgPSBUb2tlbkNhdGVnb3JpZXMuTkFNRTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICB0aGlzLmNhdGVnb3J5ID0gVG9rZW5DYXRlZ29yaWVzLlNZTUJPTDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgdmFyIHZhbGlkQ2hhclNldFRlc3QgPSAvXlt7fVxcW1xcXSgpXFwvPTosO1xcd1xcc10qJC87XHJcblxyXG4gICAgdmFyIGlzVmFsaWQgPSBmdW5jdGlvbiAodGV4dCkge1xyXG4gICAgICAgIHJldHVybiB2YWxpZENoYXJTZXRUZXN0LnRlc3QodGV4dCk7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciB0b2tlbml6ZXIgPSBmdW5jdGlvbiAodGV4dCkge1xyXG4gICAgICAgIGlmICghaXNWYWxpZCh0ZXh0KSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Bhc3NlZCBjb25maWcgY29udGFpbnMgaW52YWxpZCBjaGFyYWN0ZXJzJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHZhciByZSA9IC8oW3t9XFxbXFxdKClcXC89Oiw7XXxcXHcrKS9nO1xyXG4gICAgICAgIHZhciBtYXRjaDtcclxuICAgICAgICB2YXIgbWF0Y2hlcyA9IFtdO1xyXG4gICAgICAgIHdoaWxlICgobWF0Y2ggPSByZS5leGVjKHRleHQpKSAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICBtYXRjaGVzLnB1c2gobmV3IFN0cmluZ1Rva2VuKG1hdGNoLmluZGV4LCBtYXRjaFswXSkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbWF0Y2hlcztcclxuICAgIH07XHJcblxyXG4gICAgdmFyIGxleGVyID0gZnVuY3Rpb24gKHRva2Vucykge1xyXG4gICAgICAgIHJldHVybiB0b2tlbnMubWFwKGZ1bmN0aW9uICh0b2tlbikge1xyXG4gICAgICAgICAgICByZXR1cm4gbmV3IFRva2VuKHRva2VuKTtcclxuICAgICAgICB9KTtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIFR5cGVDYXRlZ29yaWVzID0ge1xyXG4gICAgICAgIE5BTUVEOiAwLFxyXG4gICAgICAgIE1BUF9VTk1BU0tFRDogMixcclxuICAgICAgICBNQVBfTUFTS0VEOiAzLFxyXG4gICAgICAgIFRVUExFX1VOTUFTS0VEOiA0LFxyXG4gICAgICAgIFRVUExFX01BU0tFRDogNSxcclxuICAgICAgICBBUlJBWV9VTk1BU0tFRDogNixcclxuICAgICAgICBBUlJBWV9NQVNLRUQ6IDcsXHJcbiAgICB9O1xyXG5cclxuICAgIGZ1bmN0aW9uIFR5cGUoY2F0ZWdvcnksIHByb3BlcnRpZXMsIG1hc2spIHtcclxuICAgICAgICB0aGlzLmNhdGVnb3J5ID0gY2F0ZWdvcnk7XHJcbiAgICAgICAgdGhpcy5wcm9wZXJ0aWVzID0gcHJvcGVydGllcztcclxuICAgICAgICB0aGlzLm1hc2sgPSBtYXNrIHx8IDA7XHJcbiAgICB9XHJcblxyXG4gICAgVHlwZS5wcm90b3R5cGUuZ2VuZXJhdGVIYW5kbGVyID0gZnVuY3Rpb24gKGxpYnJhcnkpIHtcclxuICAgICAgICB2YXIgaGFuZGxlcnMgPSBnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24uX2hhbmRsZXJzO1xyXG4gICAgICAgIHZhciBwcm9wcyA9IHRoaXMucHJvcGVydGllcztcclxuICAgICAgICB2YXIgbWFzayA9IHRoaXMubWFzaztcclxuICAgICAgICB2YXIgaGFuZGxlciA9IG51bGw7XHJcbiAgICAgICAgdmFyIGNoaWxkcmVuO1xyXG4gICAgICAgIHN3aXRjaCAodGhpcy5jYXRlZ29yeSkge1xyXG4gICAgICAgICAgICBjYXNlIFR5cGVDYXRlZ29yaWVzLk5BTUVEOlxyXG4gICAgICAgICAgICAgICAgaWYgKHByb3BzIGluIGhhbmRsZXJzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaGFuZGxlciA9IGhhbmRsZXJzW3Byb3BzXTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoIWhhbmRsZXIuaXNCYXNpYykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBoYW5kbGVyID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzWzBdID09PSAncycpIHtcclxuICAgICAgICAgICAgICAgICAgICB2YXIgbGVuZ3RoID0gcHJvcHMuc3Vic3RyaW5nKDEpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChudW1lcmljVGVzdC50ZXN0KGxlbmd0aCkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaGFuZGxlciA9IGhhbmRsZXJzLnN0cmluZyhwYXJzZUludChsZW5ndGgpKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzIGluIGxpYnJhcnkpIHtcclxuICAgICAgICAgICAgICAgICAgICBoYW5kbGVyID0gbGlicmFyeVtwcm9wc107XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoIWhhbmRsZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiAtMSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZXJyb3I6ICdVbnJlY29nbml6ZWQgdHlwZSBcIicgKyBwcm9wcyArICdcIicsXHJcbiAgICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJldHVybiBoYW5kbGVyO1xyXG4gICAgICAgICAgICBjYXNlIFR5cGVDYXRlZ29yaWVzLk1BUF9VTk1BU0tFRDpcclxuICAgICAgICAgICAgICAgIGNoaWxkcmVuID0gcHJvcHMubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY2hpbGQubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgaGFuZGxlcjogY2hpbGQudmFsdWUuZ2VuZXJhdGVIYW5kbGVyKGxpYnJhcnkpLFxyXG4gICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIHJldHVybiBoYW5kbGVycy5tYXBVbm1hc2tlZChjaGlsZHJlbik7XHJcbiAgICAgICAgICAgIGNhc2UgVHlwZUNhdGVnb3JpZXMuTUFQX01BU0tFRDpcclxuICAgICAgICAgICAgICAgIGNoaWxkcmVuID0gcHJvcHMubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY2hpbGQubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgaGFuZGxlcjogY2hpbGQudmFsdWUuZ2VuZXJhdGVIYW5kbGVyKGxpYnJhcnkpLFxyXG4gICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIHJldHVybiBoYW5kbGVycy5tYXBNYXNrZWQoY2hpbGRyZW4sIG1hc2spO1xyXG4gICAgICAgICAgICBjYXNlIFR5cGVDYXRlZ29yaWVzLlRVUExFX1VOTUFTS0VEOlxyXG4gICAgICAgICAgICAgICAgY2hpbGRyZW4gPSBwcm9wcy5tYXAoZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmdlbmVyYXRlSGFuZGxlcihsaWJyYXJ5KTtcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZXJzLnR1cGxlVW5tYXNrZWQoY2hpbGRyZW4pO1xyXG4gICAgICAgICAgICBjYXNlIFR5cGVDYXRlZ29yaWVzLlRVUExFX01BU0tFRDpcclxuICAgICAgICAgICAgICAgIGNoaWxkcmVuID0gcHJvcHMubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBjaGlsZC5nZW5lcmF0ZUhhbmRsZXIobGlicmFyeSk7XHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIHJldHVybiBoYW5kbGVycy50dXBsZU1hc2tlZChjaGlsZHJlbiwgbWFzayk7XHJcbiAgICAgICAgICAgIGNhc2UgVHlwZUNhdGVnb3JpZXMuQVJSQVlfVU5NQVNLRUQ6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlcnMuYXJyYXlVbm1hc2tlZChwcm9wcy5jb3VudCwgcHJvcHMudmFsdWUuZ2VuZXJhdGVIYW5kbGVyKGxpYnJhcnkpKTtcclxuICAgICAgICAgICAgY2FzZSBUeXBlQ2F0ZWdvcmllcy5BUlJBWV9NQVNLRUQ6XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlcnMuYXJyYXlNYXNrZWQocHJvcHMuY291bnQsIHByb3BzLnZhbHVlLmdlbmVyYXRlSGFuZGxlcihsaWJyYXJ5KSwgbWFzayk7XHJcbiAgICAgICAgICAgIGRlZmF1bHQ6XHJcbiAgICAgICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiAnVW5yZWNvZ25pemVkIHR5cGUgY2F0ZWdvcnknLFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciByZWFkVG9rZW4gPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIHZhciB0b2tlbiA9IHNlcmlhbGl6ZXIuZGF0YVZpZXdbc2VyaWFsaXplci5pbmRleF07XHJcbiAgICAgICAgc2VyaWFsaXplci5hZGQoMSk7XHJcbiAgICAgICAgaWYgKCF0b2tlbikge1xyXG4gICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogLTEsXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogJ1VuZXhwZWN0ZWQgZW5kIG9mIHN0cmluZycsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0b2tlbjtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIG5hbWVQYXJzZXIgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIHZhciB0b2tlbiA9IHJlYWRUb2tlbihzZXJpYWxpemVyKTtcclxuICAgICAgICBpZiAodG9rZW4uY2F0ZWdvcnkgIT09IFRva2VuQ2F0ZWdvcmllcy5OQU1FKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnRXhwZWN0ZWQgbmFtZSwgZ290OiBcIicgKyB0b2tlbi52YWx1ZSArICdcIicsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSA9PT0gJ01BU0snKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnRGlzYWxsb3dlZCBuYW1lIFwiTUFTS1wiIGdpdmVuJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHRva2VuLnZhbHVlO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgbnVtYmVyUGFyc2VyID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICB2YXIgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgaWYgKHRva2VuLmNhdGVnb3J5ICE9PSBUb2tlbkNhdGVnb3JpZXMuTlVNQkVSKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnRXhwZWN0ZWQgbnVtYmVyLCBnb3Q6IFwiJyArIHRva2VuLnZhbHVlICsgJ1wiJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHRva2VuLnZhbHVlO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgY29uc3VtZVN5bWJvbCA9IGZ1bmN0aW9uIChzZXJpYWxpemVyLCBzeW1ib2wpIHtcclxuICAgICAgICB2YXIgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgaWYgKHRva2VuLnZhbHVlICE9PSBzeW1ib2wpIHtcclxuICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6ICdFeHBlY3RlZCBcIicgKyBzeW1ib2wgKyAnXCIsIGdvdDogXCInICsgdG9rZW4udmFsdWUgKyAnXCInLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgdmFyIG1hc2tQYXJzZXIgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIC8vIFwiLy9cIiBvciBcIi88TlVNQkVSPi9cIiwgb3RoZXJ3aXNlIHRoZXJlIGlzIG5vIG1hc2tcclxuICAgICAgICAvLyBMYWJlbGVkIHdpdGggPE1BU0s+IGluIGNvbW1lbnRzIGJlbG93XHJcbiAgICAgICAgdmFyIHRva2VuID0gcmVhZFRva2VuKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSAhPT0gJy8nKSB7XHJcbiAgICAgICAgICAgIHNlcmlhbGl6ZXIuYWRkKC0xKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIG1hc2tlZDogZmFsc2UsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRva2VuID0gcmVhZFRva2VuKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSA9PT0gJy8nKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBtYXNrZWQ6IHRydWUsXHJcbiAgICAgICAgICAgICAgICBkZWZpbmVkOiBmYWxzZSxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRva2VuLmNhdGVnb3J5ICE9PSBUb2tlbkNhdGVnb3JpZXMuTlVNQkVSKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnRXhwZWN0ZWQgXCIvXCIgb3IgbnVtYmVyJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIHZhbHVlID0gdG9rZW4udmFsdWU7XHJcbiAgICAgICAgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgaWYgKHRva2VuLnZhbHVlICE9PSAnLycpIHtcclxuICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6ICdFeHBlY3RlZCBcIi9cIicsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIG1hc2tlZDogdHJ1ZSxcclxuICAgICAgICAgICAgZGVmaW5lZDogdHJ1ZSxcclxuICAgICAgICAgICAgdmFsdWU6IHZhbHVlLFxyXG4gICAgICAgIH07XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciB0eXBlTWFwUGFyc2VyID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAvLyB7PE1BU0s+IDxOQU1FPjo8VFlQRT4sIDxOQU1FPjo8VFlQRT4sIDxOQU1FPjo8VFlQRT59XHJcbiAgICAgICAgdmFyIG1hc2sgPSBtYXNrUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIHZhciBjaGlsZHJlbiA9IFtdO1xyXG4gICAgICAgIHdoaWxlICh0cnVlKSB7XHJcbiAgICAgICAgICAgIHZhciBuYW1lID0gbmFtZVBhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgY29uc3VtZVN5bWJvbChzZXJpYWxpemVyLCAnOicpO1xyXG4gICAgICAgICAgICB2YXIgdmFsdWUgPSB0eXBlUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5wdXNoKHtcclxuICAgICAgICAgICAgICAgIG5hbWU6IG5hbWUsXHJcbiAgICAgICAgICAgICAgICB2YWx1ZTogdmFsdWUsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB2YXIgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgIGlmICh0b2tlbi52YWx1ZSA9PT0gJ30nKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAobWFzay5tYXNrZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAobWFzay5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgVHlwZShUeXBlQ2F0ZWdvcmllcy5NQVBfTUFTS0VELCBjaGlsZHJlbiwgbWFzay52YWx1ZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLk1BUF9NQVNLRUQsIGNoaWxkcmVuKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgVHlwZShUeXBlQ2F0ZWdvcmllcy5NQVBfVU5NQVNLRUQsIGNoaWxkcmVuKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAodG9rZW4udmFsdWUgIT09ICcsJykge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgICAgICBlcnJvcjogJ1VuZXhwZWN0ZWQgdG9rZW4gYWZ0ZXIgbWFwIGVsZW1lbnQ6IFwiJyArIHRva2VuLnZhbHVlICsgJ1wiJyxcclxuICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciB0eXBlVHVwbGVQYXJzZXIgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIC8vICg8TUFTSz4gPFRZUEU+LCA8VFlQRT4sIDxUWVBFPilcclxuICAgICAgICB2YXIgbWFzayA9IG1hc2tQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgdmFyIGNoaWxkcmVuID0gW107XHJcbiAgICAgICAgd2hpbGUgKHRydWUpIHtcclxuICAgICAgICAgICAgY2hpbGRyZW4ucHVzaCh0eXBlUGFyc2VyKHNlcmlhbGl6ZXIpKTtcclxuICAgICAgICAgICAgdmFyIHRva2VuID0gcmVhZFRva2VuKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICBpZiAodG9rZW4udmFsdWUgPT09ICcpJykge1xyXG4gICAgICAgICAgICAgICAgaWYgKG1hc2subWFza2VkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hc2suZGVmaW5lZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFR5cGUoVHlwZUNhdGVnb3JpZXMuVFVQTEVfTUFTS0VELCBjaGlsZHJlbiwgbWFzay52YWx1ZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLlRVUExFX01BU0tFRCwgY2hpbGRyZW4pO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLlRVUExFX1VOTUFTS0VELCBjaGlsZHJlbik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHRva2VuLnZhbHVlICE9PSAnLCcpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogdG9rZW4ucG9zaXRpb24sXHJcbiAgICAgICAgICAgICAgICAgICAgZXJyb3I6ICdVbmV4cGVjdGVkIHRva2VuIGFmdGVyIHR1cGxlIGVsZW1lbnQ6IFwiJyArIHRva2VuLnZhbHVlICsgJ1wiJyxcclxuICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciB0eXBlQXJyYXlQYXJzZXIgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIC8vIFs8TUFTSz4gPFRZUEU+OjxOVU1CRVI+XVxyXG4gICAgICAgIHZhciBtYXNrID0gbWFza1BhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICB2YXIgdmFsdWUgPSB0eXBlUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIGNvbnN1bWVTeW1ib2woc2VyaWFsaXplciwgJzonKTtcclxuICAgICAgICB2YXIgY291bnQgPSBudW1iZXJQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgY29uc3VtZVN5bWJvbChzZXJpYWxpemVyLCAnXScpO1xyXG4gICAgICAgIHZhciBjaGlsZHJlbiA9IHtcclxuICAgICAgICAgICAgdmFsdWU6IHZhbHVlLFxyXG4gICAgICAgICAgICBjb3VudDogY291bnQsXHJcbiAgICAgICAgfTtcclxuICAgICAgICBpZiAobWFzay5tYXNrZWQpIHtcclxuICAgICAgICAgICAgaWYgKG1hc2suZGVmaW5lZCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLkFSUkFZX01BU0tFRCwgY2hpbGRyZW4sIG1hc2sudmFsdWUpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLkFSUkFZX01BU0tFRCwgY2hpbGRyZW4pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLkFSUkFZX1VOTUFTS0VELCBjaGlsZHJlbik7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgdHlwZVBhcnNlciA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgLy8gT3B0aW9uczpcclxuICAgICAgICAvLyAtIDxOQU1FPlxyXG4gICAgICAgIC8vIC0gVHVwbGVcclxuICAgICAgICAvLyAtIEFycmF5XHJcbiAgICAgICAgLy8gLSBNYXBcclxuICAgICAgICB2YXIgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgaWYgKCF0b2tlbikge1xyXG4gICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogLTEsXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogJ1VuZXhwZWN0ZWQgZW5kIG9mIHN0cmluZycsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0b2tlbi5jYXRlZ29yeSA9PT0gVG9rZW5DYXRlZ29yaWVzLk5VTUJFUikge1xyXG4gICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogdG9rZW4ucG9zaXRpb24sXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogJ1VuZXhwZWN0ZWQgbnVtYmVyLCB0eXBlIGV4cGVjdGVkJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRva2VuLmNhdGVnb3J5ID09PSBUb2tlbkNhdGVnb3JpZXMuTkFNRSkge1xyXG4gICAgICAgICAgICByZXR1cm4gbmV3IFR5cGUoVHlwZUNhdGVnb3JpZXMuTkFNRUQsIHRva2VuLnZhbHVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRva2VuLnZhbHVlID09PSAneycpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHR5cGVNYXBQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSA9PT0gJ1snKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB0eXBlQXJyYXlQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0b2tlbi52YWx1ZSA9PT0gJygnKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB0eXBlVHVwbGVQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICBlcnJvcjogJ1VuZXhwZWN0ZWQgdG9rZW4gd2hlbiBkZXNjcmliaW5nIHR5cGU6IFwiJyArIHRva2VuLnZhbHVlICsgJ1wiJyxcclxuICAgICAgICB9O1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgcGFyc2VyID0gZnVuY3Rpb24gKHRva2Vucywgc291cmNlKSB7XHJcbiAgICAgICAgdmFyIHNlcmlhbGl6ZXIgPSBuZXcgZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uLlNlcmlhbGl6ZXIodG9rZW5zKTtcclxuICAgICAgICB2YXIgc3RydWN0dXJlcyA9IFtdO1xyXG4gICAgICAgIHdoaWxlIChzZXJpYWxpemVyLmluZGV4IDwgc2VyaWFsaXplci5kYXRhVmlldy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgdmFyIG5hbWUgPSBuYW1lUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICBpZiAobmFtZVswXSAhPT0gbmFtZVswXS50b1VwcGVyQ2FzZSgpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiAnU3RydWN0dXJlIG5hbWVzIGNhbm5vdCBzdGFydCB3aXRoIGxvd2VyY2FzZSBsZXR0ZXJzJyxcclxuICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3VtZVN5bWJvbChzZXJpYWxpemVyLCAnPScpO1xyXG4gICAgICAgICAgICB2YXIgdmFsdWUgPSB0eXBlUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICBjb25zdW1lU3ltYm9sKHNlcmlhbGl6ZXIsICc7Jyk7XHJcbiAgICAgICAgICAgIHN0cnVjdHVyZXMucHVzaCh7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiBuYW1lLFxyXG4gICAgICAgICAgICAgICAgdmFsdWU6IHZhbHVlLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHN0cnVjdHVyZXM7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBjcmVhdGVIYW5kbGVycyA9IGZ1bmN0aW9uIChzdHJ1Y3R1cmUpIHtcclxuICAgICAgICB2YXIgbGlicmFyeSA9IHt9O1xyXG4gICAgICAgIHN0cnVjdHVyZS5mb3JFYWNoKGZ1bmN0aW9uIChlbnRyeSkge1xyXG4gICAgICAgICAgICBsaWJyYXJ5W2VudHJ5Lm5hbWVdID0gZW50cnkudmFsdWUuZ2VuZXJhdGVIYW5kbGVyKGxpYnJhcnkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJldHVybiBsaWJyYXJ5O1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgcGFyc2UgPSBmdW5jdGlvbiAodGV4dCkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjcmVhdGVIYW5kbGVycyhwYXJzZXIobGV4ZXIodG9rZW5pemVyKHRleHQpLCB0ZXh0KSwgdGV4dCkpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoZXJyLmVycm9yKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGlmICghZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uKSB7XHJcbiAgICAgICAgZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uID0ge307XHJcbiAgICB9XHJcblxyXG4gICAgZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uLl9wYXJzZXJTdGVwcyA9IHtcclxuICAgICAgICB0b2tlbml6ZXI6IHRva2VuaXplcixcclxuICAgICAgICBsZXhlcjogbGV4ZXIsXHJcbiAgICAgICAgcGFyc2VyOiBwYXJzZXIsXHJcbiAgICAgICAgVG9rZW5DYXRlZ29yaWVzOiBUb2tlbkNhdGVnb3JpZXMsXHJcbiAgICAgICAgVHlwZUNhdGVnb3JpZXM6IFR5cGVDYXRlZ29yaWVzLFxyXG4gICAgICAgIFN0cmluZ1Rva2VuOiBTdHJpbmdUb2tlbixcclxuICAgICAgICBUb2tlbjogVG9rZW4sXHJcbiAgICAgICAgVHlwZTogVHlwZSxcclxuICAgIH07XHJcblxyXG4gICAgZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uLnBhcnNlID0gcGFyc2U7XHJcblxyXG59KHRoaXMpKTtcclxuIiwiKGZ1bmN0aW9uIChnbG9iYWwpIHtcclxuICAgICd1c2Ugc3RyaWN0JztcclxuXHJcbiAgICBmdW5jdGlvbiBTZXJpYWxpemVyKGRhdGFWaWV3KSB7XHJcbiAgICAgICAgdGhpcy5pbmRleCA9IDA7XHJcbiAgICAgICAgdGhpcy5kYXRhVmlldyA9IGRhdGFWaWV3O1xyXG4gICAgfVxyXG5cclxuICAgIFNlcmlhbGl6ZXIucHJvdG90eXBlLmFkZCA9IGZ1bmN0aW9uIChpbmNyZW1lbnQpIHtcclxuICAgICAgICB0aGlzLmluZGV4ICs9IGluY3JlbWVudDtcclxuICAgIH07XHJcblxyXG4gICAgaWYgKCFnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24pIHtcclxuICAgICAgICBnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24gPSB7fTtcclxuICAgIH1cclxuICAgIGdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbi5TZXJpYWxpemVyID0gU2VyaWFsaXplcjtcclxuXHJcbn0odGhpcykpO1xyXG4iXX0=
