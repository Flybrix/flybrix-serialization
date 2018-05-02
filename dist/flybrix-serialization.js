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
                if (props[0] === 's') {
                    var length = props.substring(1);
                    if (numericTest.test(length)) {
                        handler = handlers.string(parseInt(length));
                    }
                } else if (props in handlers) {
                    handler = handlers[props];
                    if (!handler.isBasic) {
                        handler = null;
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

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1vZHVsZS5qcyIsImhhbmRsZXJzLmpzIiwicGFyc2VyLmpzIiwic2VyaWFsaXplci5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FDVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FDelhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUNoWkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZmx5YnJpeC1zZXJpYWxpemF0aW9uLmpzIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uICgpIHtcclxuICAgICd1c2Ugc3RyaWN0JztcclxuXHJcbiAgICBhbmd1bGFyLm1vZHVsZSgnZmx5YnJpeFNlcmlhbGl6YXRpb24nLCBbXSkuZmFjdG9yeSgnZmJTZXJpYWxpemVyJywgZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIFNlcmlhbGl6ZXI6IEZseWJyaXhTZXJpYWxpemF0aW9uLlNlcmlhbGl6ZXIsXHJcbiAgICAgICAgICAgIGNyZWF0ZUhhbmRsZXI6IEZseWJyaXhTZXJpYWxpemF0aW9uLnBhcnNlLFxyXG4gICAgICAgIH07XHJcbiAgICB9KTtcclxufSk7XHJcbiIsIihmdW5jdGlvbiAoZ2xvYmFsKSB7XHJcbiAgICAndXNlIHN0cmljdCc7XHJcblxyXG4gICAgdmFyIG51bGxNYXNrID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfTtcclxuXHJcbiAgICBmdW5jdGlvbiBIYW5kbGVyKGRlc2NyaXB0b3IsIGJ5dGVDb3VudCwgZW1wdHksIGVuY29kZSwgZGVjb2RlLCBmdWxsTWFzaykge1xyXG4gICAgICAgIHRoaXMuZGVzY3JpcHRvciA9IGRlc2NyaXB0b3I7XHJcbiAgICAgICAgdGhpcy5ieXRlQ291bnQgPSBieXRlQ291bnQ7XHJcbiAgICAgICAgdGhpcy5lbmNvZGUgPSBlbmNvZGU7XHJcbiAgICAgICAgdGhpcy5kZWNvZGUgPSBkZWNvZGU7XHJcbiAgICAgICAgdGhpcy5lbXB0eSA9IGVtcHR5O1xyXG4gICAgICAgIHRoaXMuZnVsbE1hc2sgPSBmdWxsTWFzayB8fCBudWxsTWFzaztcclxuICAgICAgICB0aGlzLmlzQmFzaWMgPSBmYWxzZTtcclxuICAgIH1cclxuXHJcbiAgICB2YXIgaGFuZGxlcnMgPSB7fTtcclxuXHJcbiAgICB2YXIgaGFzQml0ID0gZnVuY3Rpb24gKG1hc2ssIGlkeCkge1xyXG4gICAgICAgIHJldHVybiAobWFza1tNYXRoLmZsb29yKGlkeCAvIDgpXSAmICgxIDw8IChpZHggJSA4KSkpICE9PSAwO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgZW1wdHlOdW1lcmljID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIHJldHVybiAwO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgemVyb0FycmF5ID0gZnVuY3Rpb24gKGwpIHtcclxuICAgICAgICB2YXIgcmVzdWx0ID0gW107XHJcbiAgICAgICAgZm9yICh2YXIgaWR4ID0gMDsgaWR4IDwgbDsgKytpZHgpIHtcclxuICAgICAgICAgICAgcmVzdWx0LnB1c2goMCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBjcmVhdGVOdW1lcmljVHlwZSA9IGZ1bmN0aW9uIChrZXlTaG9ydCwga2V5LCBieXRlQ291bnQpIHtcclxuICAgICAgICB2YXIgZW5jb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEpIHtcclxuICAgICAgICAgICAgc2VyaWFsaXplci5kYXRhVmlld1snc2V0JyArIGtleV0oc2VyaWFsaXplci5pbmRleCwgZGF0YSwgMSk7XHJcbiAgICAgICAgICAgIHNlcmlhbGl6ZXIuYWRkKGJ5dGVDb3VudCk7XHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgdmFyIGRlY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgICAgIHZhciBkYXRhID0gc2VyaWFsaXplci5kYXRhVmlld1snZ2V0JyArIGtleV0oc2VyaWFsaXplci5pbmRleCwgMSk7XHJcbiAgICAgICAgICAgIHNlcmlhbGl6ZXIuYWRkKGJ5dGVDb3VudCk7XHJcbiAgICAgICAgICAgIHJldHVybiBkYXRhO1xyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIHZhciBoYW5kbGVyID0gbmV3IEhhbmRsZXIoa2V5U2hvcnQsIGJ5dGVDb3VudCwgZW1wdHlOdW1lcmljLCBlbmNvZGUsIGRlY29kZSk7XHJcblxyXG4gICAgICAgIGhhbmRsZXIuaXNCYXNpYyA9IHRydWU7XHJcblxyXG4gICAgICAgIHJldHVybiBoYW5kbGVyO1xyXG4gICAgfTtcclxuXHJcbiAgICBoYW5kbGVycy51OCA9IGNyZWF0ZU51bWVyaWNUeXBlKCd1OCcsICdVaW50OCcsIDEpO1xyXG4gICAgaGFuZGxlcnMudTE2ID0gY3JlYXRlTnVtZXJpY1R5cGUoJ3UxNicsICdVaW50MTYnLCAyKTtcclxuICAgIGhhbmRsZXJzLnUzMiA9IGNyZWF0ZU51bWVyaWNUeXBlKCd1MzInLCAnVWludDMyJywgNCk7XHJcbiAgICBoYW5kbGVycy5pOCA9IGNyZWF0ZU51bWVyaWNUeXBlKCdpOCcsICdJbnQ4JywgMSk7XHJcbiAgICBoYW5kbGVycy5pMTYgPSBjcmVhdGVOdW1lcmljVHlwZSgnaTE2JywgJ0ludDE2JywgMik7XHJcbiAgICBoYW5kbGVycy5pMzIgPSBjcmVhdGVOdW1lcmljVHlwZSgnaTMyJywgJ0ludDMyJywgNCk7XHJcbiAgICBoYW5kbGVycy5mMzIgPSBjcmVhdGVOdW1lcmljVHlwZSgnZjMyJywgJ0Zsb2F0MzInLCA0KTtcclxuICAgIGhhbmRsZXJzLmY2NCA9IGNyZWF0ZU51bWVyaWNUeXBlKCdmNjQnLCAnRmxvYXQ2NCcsIDgpO1xyXG5cclxuICAgIGhhbmRsZXJzLmJvb2wgPSBuZXcgSGFuZGxlcihcclxuICAgICAgICAnYm9vbCcsXHJcbiAgICAgICAgaGFuZGxlcnMudTguYnl0ZUNvdW50LFxyXG4gICAgICAgIGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIH0sXHJcbiAgICAgICAgZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEpIHtcclxuICAgICAgICAgICAgaGFuZGxlcnMudTguZW5jb2RlKHNlcmlhbGl6ZXIsIGRhdGEgPyAxIDogMCk7XHJcbiAgICAgICAgfSxcclxuICAgICAgICBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgICAgICByZXR1cm4gaGFuZGxlcnMudTguZGVjb2RlKHNlcmlhbGl6ZXIpICE9PSAwO1xyXG4gICAgICAgIH0pO1xyXG4gICAgaGFuZGxlcnMuYm9vbC5pc0Jhc2ljID0gdHJ1ZTtcclxuXHJcbiAgICB2YXIgYXNjaWlFbmNvZGUgPSBmdW5jdGlvbiAobmFtZSwgbGVuZ3RoKSB7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gbmV3IFVpbnQ4QXJyYXkobGVuZ3RoKTtcclxuICAgICAgICBuYW1lLnNwbGl0KCcnKS5mb3JFYWNoKGZ1bmN0aW9uIChjLCBpZHgpIHtcclxuICAgICAgICAgICAgcmVzcG9uc2VbaWR4XSA9IGMuY2hhckNvZGVBdCgwKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXNwb25zZVtsZW5ndGggLSAxXSA9IDA7XHJcbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgYXNjaWlEZWNvZGUgPSBmdW5jdGlvbiAobmFtZSwgbGVuZ3RoKSB7XHJcbiAgICAgICAgdmFyIHJlc3BvbnNlID0gJyc7XHJcbiAgICAgICAgdmFyIGwgPSBNYXRoLm1pbihuYW1lLmxlbmd0aCwgbGVuZ3RoIC0gMSk7XHJcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsOyArK2kpIHtcclxuICAgICAgICAgICAgaWYgKG5hbWVbaV0gPT09IDApIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiByZXNwb25zZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXNwb25zZSArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKG5hbWVbaV0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gcmVzcG9uc2U7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLnN0cmluZyA9IGZ1bmN0aW9uIChsZW5ndGgpIHtcclxuICAgICAgICB2YXIgaGFuZGxlciA9IGhhbmRsZXJzLmFycmF5VW5tYXNrZWQobGVuZ3RoLCBoYW5kbGVycy51OCk7XHJcbiAgICAgICAgdmFyIGVuY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyLCBkYXRhKSB7XHJcbiAgICAgICAgICAgIGhhbmRsZXIuZW5jb2RlKHNlcmlhbGl6ZXIsIGFzY2lpRW5jb2RlKGRhdGEsIGxlbmd0aCkpO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGRlY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhc2NpaURlY29kZShoYW5kbGVyLmRlY29kZShzZXJpYWxpemVyKSwgbGVuZ3RoKTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBlbXB0eSA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgcmV0dXJuICcnO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgcmV0dXJuIG5ldyBIYW5kbGVyKCdzJyArIGxlbmd0aCwgbGVuZ3RoLCBlbXB0eSwgZW5jb2RlLCBkZWNvZGUpO1xyXG4gICAgfTtcclxuXHJcbiAgICBoYW5kbGVycy5hcnJheVVubWFza2VkID0gZnVuY3Rpb24gKGxlbmd0aCwgaGFuZGxlcikge1xyXG4gICAgICAgIHZhciBjaGlsZHJlbiA9IFtdO1xyXG4gICAgICAgIGZvciAodmFyIGlkeCA9IDA7IGlkeCA8IGxlbmd0aDsgKytpZHgpIHtcclxuICAgICAgICAgICAgY2hpbGRyZW4ucHVzaChoYW5kbGVyKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIHJlc3VsdCA9IGhhbmRsZXJzLnR1cGxlVW5tYXNrZWQoY2hpbGRyZW4pO1xyXG4gICAgICAgIHJlc3VsdC5kZXNjcmlwdG9yID0gJ1snICsgaGFuZGxlci5kZXNjcmlwdG9yICsgJzonICsgbGVuZ3RoICsgJ10nO1xyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLnR1cGxlVW5tYXNrZWQgPSBmdW5jdGlvbiAoY2hpbGRyZW4pIHtcclxuICAgICAgICB2YXIgZW5jb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEsIG1hc2tzKSB7XHJcbiAgICAgICAgICAgIGlmIChtYXNrcyA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICAgICAgbWFza3MgPSBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIGNoaWxkLmVuY29kZShzZXJpYWxpemVyLCBkYXRhW2lkeF0sIG1hc2tzICYmIG1hc2tzW2lkeF0pO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBkZWNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgICAgICByZXR1cm4gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmRlY29kZShzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZW1wdHkgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjaGlsZHJlbi5tYXAoZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gY2hpbGQuZW1wdHkoKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZnVsbE1hc2sgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHZhciBub25OdWxsQ2hpbGQgPSBmYWxzZTtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCwgaWR4KSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgdmFsdWUgPSBjaGlsZC5mdWxsTWFzaygpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbm9uTnVsbENoaWxkID0gdHJ1ZTtcclxuICAgICAgICAgICAgICAgICAgICByZXN1bHRbaWR4XSA9IHZhbHVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgaWYgKCFub25OdWxsQ2hpbGQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgYnl0ZUNvdW50ID0gY2hpbGRyZW4ucmVkdWNlKGZ1bmN0aW9uIChhY2N1bSwgY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGFjY3VtICsgY2hpbGQuYnl0ZUNvdW50O1xyXG4gICAgICAgIH0sIDApO1xyXG4gICAgICAgIHZhciBjaGlsZERlc2NyaXB0b3JzID0gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gY2hpbGQuZGVzY3JpcHRvcjtcclxuICAgICAgICB9KTtcclxuICAgICAgICB2YXIgZGVzY3JpcHRvciA9ICcoJyArIGNoaWxkRGVzY3JpcHRvcnMuam9pbignLCcpICsgJyknO1xyXG4gICAgICAgIHJldHVybiBuZXcgSGFuZGxlcihkZXNjcmlwdG9yLCBieXRlQ291bnQsIGVtcHR5LCBlbmNvZGUsIGRlY29kZSwgZnVsbE1hc2spO1xyXG4gICAgfTtcclxuXHJcbiAgICBoYW5kbGVycy5hcnJheU1hc2tlZCA9IGZ1bmN0aW9uIChsZW5ndGgsIGhhbmRsZXIsIG1hc2tCaXRDb3VudCkge1xyXG4gICAgICAgIHZhciBjaGlsZHJlbiA9IFtdO1xyXG4gICAgICAgIGZvciAodmFyIGlkeCA9IDA7IGlkeCA8IGxlbmd0aDsgKytpZHgpIHtcclxuICAgICAgICAgICAgY2hpbGRyZW4ucHVzaChoYW5kbGVyKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIHJlc3VsdCA9IGhhbmRsZXJzLnR1cGxlTWFza2VkKGNoaWxkcmVuLCBtYXNrQml0Q291bnQpO1xyXG4gICAgICAgIHZhciBtYXNrU2l6ZSA9IChyZXN1bHQuYnl0ZUNvdW50IC0gKGxlbmd0aCAqIGhhbmRsZXIuYnl0ZUNvdW50KSkgKiA4O1xyXG4gICAgICAgIHJlc3VsdC5kZXNjcmlwdG9yID0gJ1svJyArIG1hc2tTaXplICsgJy8nICsgaGFuZGxlci5kZXNjcmlwdG9yICsgJzonICsgbGVuZ3RoICsgJ10nO1xyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLnR1cGxlTWFza2VkID0gZnVuY3Rpb24gKGNoaWxkcmVuLCBtYXNrQml0Q291bnQpIHtcclxuICAgICAgICB2YXIgbWFza0J5dGVzID0gTWF0aC5jZWlsKGNoaWxkcmVuLmxlbmd0aCAvIDgpO1xyXG4gICAgICAgIGlmIChtYXNrQml0Q291bnQpIHtcclxuICAgICAgICAgICAgbWFza0J5dGVzID0gTWF0aC5tYXgobWFza0J5dGVzLCBNYXRoLmNlaWwobWFza0JpdENvdW50IC8gOCkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB2YXIgbWFza0hhbmRsZXIgPSBoYW5kbGVycy5hcnJheVVubWFza2VkKG1hc2tCeXRlcywgaGFuZGxlcnMudTgpO1xyXG4gICAgICAgIHZhciBlbmNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplciwgZGF0YSwgbWFza3MpIHtcclxuICAgICAgICAgICAgaWYgKG1hc2tzID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgICAgICBtYXNrcyA9IG51bGw7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdmFyIG1hc2sgPSB6ZXJvQXJyYXkobWFza0J5dGVzKTtcclxuICAgICAgICAgICAgdmFyIGV4dHJhTWFzayA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChtYXNrcyAmJiAoJ01BU0snIGluIG1hc2tzKSkge1xyXG4gICAgICAgICAgICAgICAgZXh0cmFNYXNrID0gbWFza3MuTUFTSztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChfLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIHZhciB2YWx1ZSA9IGRhdGFbaWR4XTtcclxuICAgICAgICAgICAgICAgIGlmIChleHRyYU1hc2sgJiYgIWV4dHJhTWFza1tpZHhdKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlICE9PSBudWxsICYmIHZhbHVlICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBtYXNrW01hdGguZmxvb3IoaWR4IC8gOCldIHw9IDEgPDwgKGlkeCAlIDgpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgICAgIG1hc2tIYW5kbGVyLmVuY29kZShzZXJpYWxpemVyLCBtYXNrKTtcclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoY2hpbGQsIGlkeCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGhhc0JpdChtYXNrLCBpZHgpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY2hpbGQuZW5jb2RlKHNlcmlhbGl6ZXIsIGRhdGFbaWR4XSwgbWFza3MgJiYgbWFza3NbaWR4XSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGRlY29kZSA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgICAgIHZhciBtYXNrID0gbWFza0hhbmRsZXIuZGVjb2RlKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uIChjaGlsZCwgaWR4KSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoaGFzQml0KG1hc2ssIGlkeCkpIHtcclxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gY2hpbGQuZGVjb2RlKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGVtcHR5ID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmVtcHR5KCk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGZ1bGxNYXNrID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0ge307XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIHZhciB2YWx1ZSA9IGNoaWxkLmZ1bGxNYXNrKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUgIT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgICAgICByZXN1bHRbaWR4XSA9IHZhbHVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmVzdWx0Lk1BU0sgPSBjaGlsZHJlbi5tYXAoZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGJ5dGVDb3VudCA9IGNoaWxkcmVuLnJlZHVjZShmdW5jdGlvbiAoYWNjdW0sIGNoaWxkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhY2N1bSArIGNoaWxkLmJ5dGVDb3VudDtcclxuICAgICAgICB9LCBtYXNrQnl0ZXMpO1xyXG4gICAgICAgIHZhciBjaGlsZERlc2NyaXB0b3JzID0gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gY2hpbGQuZGVzY3JpcHRvcjtcclxuICAgICAgICB9KTtcclxuICAgICAgICB2YXIgZGVzY3JpcHRvciA9ICcoLycgKyAobWFza0J5dGVzICogOCkgKyAnLycgKyBjaGlsZERlc2NyaXB0b3JzLmpvaW4oJywnKSArICcpJztcclxuICAgICAgICByZXR1cm4gbmV3IEhhbmRsZXIoZGVzY3JpcHRvciwgYnl0ZUNvdW50LCBlbXB0eSwgZW5jb2RlLCBkZWNvZGUsIGZ1bGxNYXNrKTtcclxuICAgIH07XHJcblxyXG4gICAgaGFuZGxlcnMubWFwVW5tYXNrZWQgPSBmdW5jdGlvbiAoY2hpbGRyZW4pIHtcclxuICAgICAgICB2YXIgZW5jb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEsIG1hc2tzKSB7XHJcbiAgICAgICAgICAgIGlmIChtYXNrcyA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICAgICAgbWFza3MgPSBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICBjaGlsZC5oYW5kbGVyLmVuY29kZShzZXJpYWxpemVyLCBkYXRhW2NoaWxkLmtleV0sIG1hc2tzICYmIG1hc2tzW2NoaWxkLmtleV0pO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBkZWNvZGUgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0ge307XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICByZXN1bHRbY2hpbGQua2V5XSA9IGNoaWxkLmhhbmRsZXIuZGVjb2RlKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBlbXB0eSA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkLmtleV0gPSBjaGlsZC5oYW5kbGVyLmVtcHR5KCk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGZ1bGxNYXNrID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICB2YXIgbm9uTnVsbENoaWxkID0gZmFsc2U7XHJcbiAgICAgICAgICAgIHZhciByZXN1bHQgPSB7fTtcclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgIHZhciB2YWx1ZSA9IGNoaWxkLmhhbmRsZXIuZnVsbE1hc2soKTtcclxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZSAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgICAgIG5vbk51bGxDaGlsZCA9IHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkLmtleV0gPSB2YWx1ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGlmICghbm9uTnVsbENoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGJ5dGVDb3VudCA9IGNoaWxkcmVuLnJlZHVjZShmdW5jdGlvbiAoYWNjdW0sIGNoaWxkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhY2N1bSArIGNoaWxkLmhhbmRsZXIuYnl0ZUNvdW50O1xyXG4gICAgICAgIH0sIDApO1xyXG4gICAgICAgIHZhciBjaGlsZERlc2NyaXB0b3JzID0gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gY2hpbGQua2V5ICsgJzonICsgY2hpbGQuaGFuZGxlci5kZXNjcmlwdG9yO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHZhciBkZXNjcmlwdG9yID0gJ3snICsgY2hpbGREZXNjcmlwdG9ycy5qb2luKCcsJykgKyAnfSc7XHJcbiAgICAgICAgcmV0dXJuIG5ldyBIYW5kbGVyKGRlc2NyaXB0b3IsIGJ5dGVDb3VudCwgZW1wdHksIGVuY29kZSwgZGVjb2RlLCBmdWxsTWFzayk7XHJcbiAgICB9O1xyXG5cclxuICAgIGhhbmRsZXJzLm1hcE1hc2tlZCA9IGZ1bmN0aW9uIChjaGlsZHJlbiwgbWFza0JpdENvdW50KSB7XHJcbiAgICAgICAgdmFyIG1hc2tCeXRlcyA9IE1hdGguY2VpbChjaGlsZHJlbi5sZW5ndGggLyA4KTtcclxuICAgICAgICBpZiAobWFza0JpdENvdW50KSB7XHJcbiAgICAgICAgICAgIG1hc2tCeXRlcyA9IE1hdGgubWF4KG1hc2tCeXRlcywgTWF0aC5jZWlsKG1hc2tCaXRDb3VudCAvIDgpKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIG1hc2tIYW5kbGVyID0gaGFuZGxlcnMuYXJyYXlVbm1hc2tlZChtYXNrQnl0ZXMsIGhhbmRsZXJzLnU4KTtcclxuICAgICAgICB2YXIgZW5jb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIGRhdGEsIG1hc2tzKSB7XHJcbiAgICAgICAgICAgIGlmIChtYXNrcyA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICAgICAgbWFza3MgPSBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHZhciBtYXNrID0gemVyb0FycmF5KG1hc2tCeXRlcyk7XHJcbiAgICAgICAgICAgIHZhciBleHRyYU1hc2sgPSBudWxsO1xyXG4gICAgICAgICAgICBpZiAobWFza3MgJiYgKCdNQVNLJyBpbiBtYXNrcykpIHtcclxuICAgICAgICAgICAgICAgIGV4dHJhTWFzayA9IG1hc2tzLk1BU0s7XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkLCBpZHgpIHtcclxuICAgICAgICAgICAgICAgIHZhciB2YWx1ZSA9IGRhdGFbY2hpbGQua2V5XTtcclxuICAgICAgICAgICAgICAgIGlmIChleHRyYU1hc2sgJiYgIWV4dHJhTWFza1tjaGlsZC5rZXldKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlICE9PSBudWxsICYmIHZhbHVlICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBtYXNrW01hdGguZmxvb3IoaWR4IC8gOCldIHw9IDEgPDwgKGlkeCAlIDgpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgICAgIG1hc2tIYW5kbGVyLmVuY29kZShzZXJpYWxpemVyLCBtYXNrKTtcclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoY2hpbGQsIGlkeCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGhhc0JpdChtYXNrLCBpZHgpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY2hpbGQuaGFuZGxlci5lbmNvZGUoc2VyaWFsaXplciwgZGF0YVtjaGlsZC5rZXldLCBtYXNrcyAmJiBtYXNrc1tjaGlsZC5rZXldKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2YXIgZGVjb2RlID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAgICAgdmFyIG1hc2sgPSBtYXNrSGFuZGxlci5kZWNvZGUoc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgIHZhciByZXN1bHQgPSB7fTtcclxuICAgICAgICAgICAgY2hpbGRyZW4uZm9yRWFjaChmdW5jdGlvbiAoY2hpbGQsIGlkeCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGhhc0JpdChtYXNrLCBpZHgpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkLmtleV0gPSBjaGlsZC5oYW5kbGVyLmRlY29kZShzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkLmtleV0gPSBudWxsO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBlbXB0eSA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IHt9O1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5mb3JFYWNoKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkLmtleV0gPSBjaGlsZC5oYW5kbGVyLmVtcHR5KCk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgdmFyIGZ1bGxNYXNrID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICB2YXIgcmVzdWx0ID0ge307XHJcbiAgICAgICAgICAgIHZhciBtYXNrID0ge307XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLmZvckVhY2goZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICB2YXIgdmFsdWUgPSBjaGlsZC5oYW5kbGVyLmZ1bGxNYXNrKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUgIT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY2hpbGQua2V5XSA9IHZhbHVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgbWFza1tjaGlsZC5rZXldID0gdHJ1ZTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJlc3VsdC5NQVNLID0gbWFzaztcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHZhciBieXRlQ291bnQgPSBjaGlsZHJlbi5yZWR1Y2UoZnVuY3Rpb24gKGFjY3VtLCBjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gYWNjdW0gKyBjaGlsZC5oYW5kbGVyLmJ5dGVDb3VudDtcclxuICAgICAgICB9LCBtYXNrQnl0ZXMpO1xyXG4gICAgICAgIHZhciBjaGlsZERlc2NyaXB0b3JzID0gY2hpbGRyZW4ubWFwKGZ1bmN0aW9uIChjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gY2hpbGQua2V5ICsgJzonICsgY2hpbGQuaGFuZGxlci5kZXNjcmlwdG9yO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHZhciBkZXNjcmlwdG9yID0gJ3svJyArIChtYXNrQnl0ZXMgKiA4KSArICcvJyArIGNoaWxkRGVzY3JpcHRvcnMuam9pbignLCcpICsgJ30nO1xyXG4gICAgICAgIHJldHVybiBuZXcgSGFuZGxlcihkZXNjcmlwdG9yLCBieXRlQ291bnQsIGVtcHR5LCBlbmNvZGUsIGRlY29kZSwgZnVsbE1hc2spO1xyXG4gICAgfTtcclxuXHJcbiAgICBpZiAoIWdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbikge1xyXG4gICAgICAgIGdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbiA9IHt9O1xyXG4gICAgfVxyXG4gICAgZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uLl9oYW5kbGVycyA9IGhhbmRsZXJzO1xyXG5cclxufSh0aGlzKSk7XHJcbiIsIihmdW5jdGlvbiAoZ2xvYmFsKSB7XHJcbiAgICAndXNlIHN0cmljdCc7XHJcblxyXG4gICAgZnVuY3Rpb24gU3RyaW5nVG9rZW4ocG9zaXRpb24sIHZhbHVlKSB7XHJcbiAgICAgICAgdGhpcy5wb3NpdGlvbiA9IHBvc2l0aW9uO1xyXG4gICAgICAgIHRoaXMudmFsdWUgPSB2YWx1ZTtcclxuICAgIH1cclxuXHJcbiAgICB2YXIgbnVtZXJpY1Rlc3QgPSAvXlxcZCskLztcclxuICAgIHZhciBuYW1lVGVzdCA9IC9eXFx3KyQvO1xyXG5cclxuICAgIHZhciBUb2tlbkNhdGVnb3JpZXMgPSB7XHJcbiAgICAgICAgU1lNQk9MOiAwLFxyXG4gICAgICAgIE5VTUJFUjogMSxcclxuICAgICAgICBOQU1FOiAyLFxyXG4gICAgfTtcclxuXHJcbiAgICBmdW5jdGlvbiBUb2tlbihzdHJpbmdUb2tlbikge1xyXG4gICAgICAgIHRoaXMucG9zaXRpb24gPSBzdHJpbmdUb2tlbi5wb3NpdGlvbjtcclxuICAgICAgICB0aGlzLnZhbHVlID0gc3RyaW5nVG9rZW4udmFsdWU7XHJcbiAgICAgICAgaWYgKG51bWVyaWNUZXN0LnRlc3QodGhpcy52YWx1ZSkpIHtcclxuICAgICAgICAgICAgdGhpcy5jYXRlZ29yeSA9IFRva2VuQ2F0ZWdvcmllcy5OVU1CRVI7XHJcbiAgICAgICAgICAgIHRoaXMudmFsdWUgPSBwYXJzZUludCh0aGlzLnZhbHVlKTtcclxuICAgICAgICB9IGVsc2UgaWYgKG5hbWVUZXN0LnRlc3QodGhpcy52YWx1ZSkpIHtcclxuICAgICAgICAgICAgdGhpcy5jYXRlZ29yeSA9IFRva2VuQ2F0ZWdvcmllcy5OQU1FO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHRoaXMuY2F0ZWdvcnkgPSBUb2tlbkNhdGVnb3JpZXMuU1lNQk9MO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICB2YXIgdmFsaWRDaGFyU2V0VGVzdCA9IC9eW3t9XFxbXFxdKClcXC89Oiw7XFx3XFxzXSokLztcclxuXHJcbiAgICB2YXIgaXNWYWxpZCA9IGZ1bmN0aW9uICh0ZXh0KSB7XHJcbiAgICAgICAgcmV0dXJuIHZhbGlkQ2hhclNldFRlc3QudGVzdCh0ZXh0KTtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIHRva2VuaXplciA9IGZ1bmN0aW9uICh0ZXh0KSB7XHJcbiAgICAgICAgaWYgKCFpc1ZhbGlkKHRleHQpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUGFzc2VkIGNvbmZpZyBjb250YWlucyBpbnZhbGlkIGNoYXJhY3RlcnMnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdmFyIHJlID0gLyhbe31cXFtcXF0oKVxcLz06LDtdfFxcdyspL2c7XHJcbiAgICAgICAgdmFyIG1hdGNoO1xyXG4gICAgICAgIHZhciBtYXRjaGVzID0gW107XHJcbiAgICAgICAgd2hpbGUgKChtYXRjaCA9IHJlLmV4ZWModGV4dCkpICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgIG1hdGNoZXMucHVzaChuZXcgU3RyaW5nVG9rZW4obWF0Y2guaW5kZXgsIG1hdGNoWzBdKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBtYXRjaGVzO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgbGV4ZXIgPSBmdW5jdGlvbiAodG9rZW5zKSB7XHJcbiAgICAgICAgcmV0dXJuIHRva2Vucy5tYXAoZnVuY3Rpb24gKHRva2VuKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBuZXcgVG9rZW4odG9rZW4pO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgVHlwZUNhdGVnb3JpZXMgPSB7XHJcbiAgICAgICAgTkFNRUQ6IDAsXHJcbiAgICAgICAgTUFQX1VOTUFTS0VEOiAyLFxyXG4gICAgICAgIE1BUF9NQVNLRUQ6IDMsXHJcbiAgICAgICAgVFVQTEVfVU5NQVNLRUQ6IDQsXHJcbiAgICAgICAgVFVQTEVfTUFTS0VEOiA1LFxyXG4gICAgICAgIEFSUkFZX1VOTUFTS0VEOiA2LFxyXG4gICAgICAgIEFSUkFZX01BU0tFRDogNyxcclxuICAgIH07XHJcblxyXG4gICAgZnVuY3Rpb24gVHlwZShjYXRlZ29yeSwgcHJvcGVydGllcywgbWFzaykge1xyXG4gICAgICAgIHRoaXMuY2F0ZWdvcnkgPSBjYXRlZ29yeTtcclxuICAgICAgICB0aGlzLnByb3BlcnRpZXMgPSBwcm9wZXJ0aWVzO1xyXG4gICAgICAgIHRoaXMubWFzayA9IG1hc2sgfHwgMDtcclxuICAgIH1cclxuXHJcbiAgICBUeXBlLnByb3RvdHlwZS5nZW5lcmF0ZUhhbmRsZXIgPSBmdW5jdGlvbiAobGlicmFyeSkge1xyXG4gICAgICAgIHZhciBoYW5kbGVycyA9IGdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbi5faGFuZGxlcnM7XHJcbiAgICAgICAgdmFyIHByb3BzID0gdGhpcy5wcm9wZXJ0aWVzO1xyXG4gICAgICAgIHZhciBtYXNrID0gdGhpcy5tYXNrO1xyXG4gICAgICAgIHZhciBoYW5kbGVyID0gbnVsbDtcclxuICAgICAgICB2YXIgY2hpbGRyZW47XHJcbiAgICAgICAgc3dpdGNoICh0aGlzLmNhdGVnb3J5KSB7XHJcbiAgICAgICAgICAgIGNhc2UgVHlwZUNhdGVnb3JpZXMuTkFNRUQ6XHJcbiAgICAgICAgICAgICAgICBpZiAocHJvcHNbMF0gPT09ICdzJykge1xyXG4gICAgICAgICAgICAgICAgICAgIHZhciBsZW5ndGggPSBwcm9wcy5zdWJzdHJpbmcoMSk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKG51bWVyaWNUZXN0LnRlc3QobGVuZ3RoKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBoYW5kbGVyID0gaGFuZGxlcnMuc3RyaW5nKHBhcnNlSW50KGxlbmd0aCkpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMgaW4gaGFuZGxlcnMpIHtcclxuICAgICAgICAgICAgICAgICAgICBoYW5kbGVyID0gaGFuZGxlcnNbcHJvcHNdO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghaGFuZGxlci5pc0Jhc2ljKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGhhbmRsZXIgPSBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMgaW4gbGlicmFyeSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGhhbmRsZXIgPSBsaWJyYXJ5W3Byb3BzXTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmICghaGFuZGxlcikge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogJ1VucmVjb2duaXplZCB0eXBlIFwiJyArIHByb3BzICsgJ1wiJyxcclxuICAgICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZXI7XHJcbiAgICAgICAgICAgIGNhc2UgVHlwZUNhdGVnb3JpZXMuTUFQX1VOTUFTS0VEOlxyXG4gICAgICAgICAgICAgICAgY2hpbGRyZW4gPSBwcm9wcy5tYXAoZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjaGlsZC5uYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBoYW5kbGVyOiBjaGlsZC52YWx1ZS5nZW5lcmF0ZUhhbmRsZXIobGlicmFyeSksXHJcbiAgICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZXJzLm1hcFVubWFza2VkKGNoaWxkcmVuKTtcclxuICAgICAgICAgICAgY2FzZSBUeXBlQ2F0ZWdvcmllcy5NQVBfTUFTS0VEOlxyXG4gICAgICAgICAgICAgICAgY2hpbGRyZW4gPSBwcm9wcy5tYXAoZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjaGlsZC5uYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBoYW5kbGVyOiBjaGlsZC52YWx1ZS5nZW5lcmF0ZUhhbmRsZXIobGlicmFyeSksXHJcbiAgICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZXJzLm1hcE1hc2tlZChjaGlsZHJlbiwgbWFzayk7XHJcbiAgICAgICAgICAgIGNhc2UgVHlwZUNhdGVnb3JpZXMuVFVQTEVfVU5NQVNLRUQ6XHJcbiAgICAgICAgICAgICAgICBjaGlsZHJlbiA9IHByb3BzLm1hcChmdW5jdGlvbiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gY2hpbGQuZ2VuZXJhdGVIYW5kbGVyKGxpYnJhcnkpO1xyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlcnMudHVwbGVVbm1hc2tlZChjaGlsZHJlbik7XHJcbiAgICAgICAgICAgIGNhc2UgVHlwZUNhdGVnb3JpZXMuVFVQTEVfTUFTS0VEOlxyXG4gICAgICAgICAgICAgICAgY2hpbGRyZW4gPSBwcm9wcy5tYXAoZnVuY3Rpb24gKGNoaWxkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGNoaWxkLmdlbmVyYXRlSGFuZGxlcihsaWJyYXJ5KTtcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGhhbmRsZXJzLnR1cGxlTWFza2VkKGNoaWxkcmVuLCBtYXNrKTtcclxuICAgICAgICAgICAgY2FzZSBUeXBlQ2F0ZWdvcmllcy5BUlJBWV9VTk1BU0tFRDpcclxuICAgICAgICAgICAgICAgIHJldHVybiBoYW5kbGVycy5hcnJheVVubWFza2VkKHByb3BzLmNvdW50LCBwcm9wcy52YWx1ZS5nZW5lcmF0ZUhhbmRsZXIobGlicmFyeSkpO1xyXG4gICAgICAgICAgICBjYXNlIFR5cGVDYXRlZ29yaWVzLkFSUkFZX01BU0tFRDpcclxuICAgICAgICAgICAgICAgIHJldHVybiBoYW5kbGVycy5hcnJheU1hc2tlZChwcm9wcy5jb3VudCwgcHJvcHMudmFsdWUuZ2VuZXJhdGVIYW5kbGVyKGxpYnJhcnkpLCBtYXNrKTtcclxuICAgICAgICAgICAgZGVmYXVsdDpcclxuICAgICAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogLTEsXHJcbiAgICAgICAgICAgICAgICAgICAgZXJyb3I6ICdVbnJlY29nbml6ZWQgdHlwZSBjYXRlZ29yeScsXHJcbiAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgdmFyIHJlYWRUb2tlbiA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgdmFyIHRva2VuID0gc2VyaWFsaXplci5kYXRhVmlld1tzZXJpYWxpemVyLmluZGV4XTtcclxuICAgICAgICBzZXJpYWxpemVyLmFkZCgxKTtcclxuICAgICAgICBpZiAoIXRva2VuKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiAtMSxcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnVW5leHBlY3RlZCBlbmQgb2Ygc3RyaW5nJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHRva2VuO1xyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgbmFtZVBhcnNlciA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgdmFyIHRva2VuID0gcmVhZFRva2VuKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIGlmICh0b2tlbi5jYXRlZ29yeSAhPT0gVG9rZW5DYXRlZ29yaWVzLk5BTUUpIHtcclxuICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6ICdFeHBlY3RlZCBuYW1lLCBnb3Q6IFwiJyArIHRva2VuLnZhbHVlICsgJ1wiJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRva2VuLnZhbHVlID09PSAnTUFTSycpIHtcclxuICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6ICdEaXNhbGxvd2VkIG5hbWUgXCJNQVNLXCIgZ2l2ZW4nLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gdG9rZW4udmFsdWU7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBudW1iZXJQYXJzZXIgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIHZhciB0b2tlbiA9IHJlYWRUb2tlbihzZXJpYWxpemVyKTtcclxuICAgICAgICBpZiAodG9rZW4uY2F0ZWdvcnkgIT09IFRva2VuQ2F0ZWdvcmllcy5OVU1CRVIpIHtcclxuICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6ICdFeHBlY3RlZCBudW1iZXIsIGdvdDogXCInICsgdG9rZW4udmFsdWUgKyAnXCInLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gdG9rZW4udmFsdWU7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBjb25zdW1lU3ltYm9sID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIsIHN5bWJvbCkge1xyXG4gICAgICAgIHZhciB0b2tlbiA9IHJlYWRUb2tlbihzZXJpYWxpemVyKTtcclxuICAgICAgICBpZiAodG9rZW4udmFsdWUgIT09IHN5bWJvbCkge1xyXG4gICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogdG9rZW4ucG9zaXRpb24sXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogJ0V4cGVjdGVkIFwiJyArIHN5bWJvbCArICdcIiwgZ290OiBcIicgKyB0b2tlbi52YWx1ZSArICdcIicsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICB2YXIgbWFza1BhcnNlciA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgLy8gXCIvL1wiIG9yIFwiLzxOVU1CRVI+L1wiLCBvdGhlcndpc2UgdGhlcmUgaXMgbm8gbWFza1xyXG4gICAgICAgIC8vIExhYmVsZWQgd2l0aCA8TUFTSz4gaW4gY29tbWVudHMgYmVsb3dcclxuICAgICAgICB2YXIgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgaWYgKHRva2VuLnZhbHVlICE9PSAnLycpIHtcclxuICAgICAgICAgICAgc2VyaWFsaXplci5hZGQoLTEpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgbWFza2VkOiBmYWxzZSxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgaWYgKHRva2VuLnZhbHVlID09PSAnLycpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIG1hc2tlZDogdHJ1ZSxcclxuICAgICAgICAgICAgICAgIGRlZmluZWQ6IGZhbHNlLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodG9rZW4uY2F0ZWdvcnkgIT09IFRva2VuQ2F0ZWdvcmllcy5OVU1CRVIpIHtcclxuICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6ICdFeHBlY3RlZCBcIi9cIiBvciBudW1iZXInLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICB2YXIgdmFsdWUgPSB0b2tlbi52YWx1ZTtcclxuICAgICAgICB0b2tlbiA9IHJlYWRUb2tlbihzZXJpYWxpemVyKTtcclxuICAgICAgICBpZiAodG9rZW4udmFsdWUgIT09ICcvJykge1xyXG4gICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICBwb3NpdGlvbjogdG9rZW4ucG9zaXRpb24sXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogJ0V4cGVjdGVkIFwiL1wiJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgbWFza2VkOiB0cnVlLFxyXG4gICAgICAgICAgICBkZWZpbmVkOiB0cnVlLFxyXG4gICAgICAgICAgICB2YWx1ZTogdmFsdWUsXHJcbiAgICAgICAgfTtcclxuICAgIH07XHJcblxyXG4gICAgdmFyIHR5cGVNYXBQYXJzZXIgPSBmdW5jdGlvbiAoc2VyaWFsaXplcikge1xyXG4gICAgICAgIC8vIHs8TUFTSz4gPE5BTUU+OjxUWVBFPiwgPE5BTUU+OjxUWVBFPiwgPE5BTUU+OjxUWVBFPn1cclxuICAgICAgICB2YXIgbWFzayA9IG1hc2tQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgdmFyIGNoaWxkcmVuID0gW107XHJcbiAgICAgICAgd2hpbGUgKHRydWUpIHtcclxuICAgICAgICAgICAgdmFyIG5hbWUgPSBuYW1lUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgICAgICBjb25zdW1lU3ltYm9sKHNlcmlhbGl6ZXIsICc6Jyk7XHJcbiAgICAgICAgICAgIHZhciB2YWx1ZSA9IHR5cGVQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgIGNoaWxkcmVuLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgbmFtZTogbmFtZSxcclxuICAgICAgICAgICAgICAgIHZhbHVlOiB2YWx1ZSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHZhciB0b2tlbiA9IHJlYWRUb2tlbihzZXJpYWxpemVyKTtcclxuICAgICAgICAgICAgaWYgKHRva2VuLnZhbHVlID09PSAnfScpIHtcclxuICAgICAgICAgICAgICAgIGlmIChtYXNrLm1hc2tlZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChtYXNrLmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLk1BUF9NQVNLRUQsIGNoaWxkcmVuLCBtYXNrLnZhbHVlKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFR5cGUoVHlwZUNhdGVnb3JpZXMuTUFQX01BU0tFRCwgY2hpbGRyZW4pO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBUeXBlKFR5cGVDYXRlZ29yaWVzLk1BUF9VTk1BU0tFRCwgY2hpbGRyZW4pO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICh0b2tlbi52YWx1ZSAhPT0gJywnKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IHRva2VuLnBvc2l0aW9uLFxyXG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiAnVW5leHBlY3RlZCB0b2tlbiBhZnRlciBtYXAgZWxlbWVudDogXCInICsgdG9rZW4udmFsdWUgKyAnXCInLFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgdmFyIHR5cGVUdXBsZVBhcnNlciA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgLy8gKDxNQVNLPiA8VFlQRT4sIDxUWVBFPiwgPFRZUEU+KVxyXG4gICAgICAgIHZhciBtYXNrID0gbWFza1BhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICB2YXIgY2hpbGRyZW4gPSBbXTtcclxuICAgICAgICB3aGlsZSAodHJ1ZSkge1xyXG4gICAgICAgICAgICBjaGlsZHJlbi5wdXNoKHR5cGVQYXJzZXIoc2VyaWFsaXplcikpO1xyXG4gICAgICAgICAgICB2YXIgdG9rZW4gPSByZWFkVG9rZW4oc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgIGlmICh0b2tlbi52YWx1ZSA9PT0gJyknKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAobWFzay5tYXNrZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAobWFzay5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgVHlwZShUeXBlQ2F0ZWdvcmllcy5UVVBMRV9NQVNLRUQsIGNoaWxkcmVuLCBtYXNrLnZhbHVlKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFR5cGUoVHlwZUNhdGVnb3JpZXMuVFVQTEVfTUFTS0VELCBjaGlsZHJlbik7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFR5cGUoVHlwZUNhdGVnb3JpZXMuVFVQTEVfVU5NQVNLRUQsIGNoaWxkcmVuKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAodG9rZW4udmFsdWUgIT09ICcsJykge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgICAgICBlcnJvcjogJ1VuZXhwZWN0ZWQgdG9rZW4gYWZ0ZXIgdHVwbGUgZWxlbWVudDogXCInICsgdG9rZW4udmFsdWUgKyAnXCInLFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgdmFyIHR5cGVBcnJheVBhcnNlciA9IGZ1bmN0aW9uIChzZXJpYWxpemVyKSB7XHJcbiAgICAgICAgLy8gWzxNQVNLPiA8VFlQRT46PE5VTUJFUj5dXHJcbiAgICAgICAgdmFyIG1hc2sgPSBtYXNrUGFyc2VyKHNlcmlhbGl6ZXIpO1xyXG4gICAgICAgIHZhciB2YWx1ZSA9IHR5cGVQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgY29uc3VtZVN5bWJvbChzZXJpYWxpemVyLCAnOicpO1xyXG4gICAgICAgIHZhciBjb3VudCA9IG51bWJlclBhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICBjb25zdW1lU3ltYm9sKHNlcmlhbGl6ZXIsICddJyk7XHJcbiAgICAgICAgdmFyIGNoaWxkcmVuID0ge1xyXG4gICAgICAgICAgICB2YWx1ZTogdmFsdWUsXHJcbiAgICAgICAgICAgIGNvdW50OiBjb3VudCxcclxuICAgICAgICB9O1xyXG4gICAgICAgIGlmIChtYXNrLm1hc2tlZCkge1xyXG4gICAgICAgICAgICBpZiAobWFzay5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFR5cGUoVHlwZUNhdGVnb3JpZXMuQVJSQVlfTUFTS0VELCBjaGlsZHJlbiwgbWFzay52YWx1ZSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFR5cGUoVHlwZUNhdGVnb3JpZXMuQVJSQVlfTUFTS0VELCBjaGlsZHJlbik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICByZXR1cm4gbmV3IFR5cGUoVHlwZUNhdGVnb3JpZXMuQVJSQVlfVU5NQVNLRUQsIGNoaWxkcmVuKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciB0eXBlUGFyc2VyID0gZnVuY3Rpb24gKHNlcmlhbGl6ZXIpIHtcclxuICAgICAgICAvLyBPcHRpb25zOlxyXG4gICAgICAgIC8vIC0gPE5BTUU+XHJcbiAgICAgICAgLy8gLSBUdXBsZVxyXG4gICAgICAgIC8vIC0gQXJyYXlcclxuICAgICAgICAvLyAtIE1hcFxyXG4gICAgICAgIHZhciB0b2tlbiA9IHJlYWRUb2tlbihzZXJpYWxpemVyKTtcclxuICAgICAgICBpZiAoIXRva2VuKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiAtMSxcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnVW5leHBlY3RlZCBlbmQgb2Ygc3RyaW5nJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRva2VuLmNhdGVnb3J5ID09PSBUb2tlbkNhdGVnb3JpZXMuTlVNQkVSKSB7XHJcbiAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgIHBvc2l0aW9uOiB0b2tlbi5wb3NpdGlvbixcclxuICAgICAgICAgICAgICAgIGVycm9yOiAnVW5leHBlY3RlZCBudW1iZXIsIHR5cGUgZXhwZWN0ZWQnLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodG9rZW4uY2F0ZWdvcnkgPT09IFRva2VuQ2F0ZWdvcmllcy5OQU1FKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBuZXcgVHlwZShUeXBlQ2F0ZWdvcmllcy5OQU1FRCwgdG9rZW4udmFsdWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodG9rZW4udmFsdWUgPT09ICd7Jykge1xyXG4gICAgICAgICAgICByZXR1cm4gdHlwZU1hcFBhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRva2VuLnZhbHVlID09PSAnWycpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHR5cGVBcnJheVBhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRva2VuLnZhbHVlID09PSAnKCcpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHR5cGVUdXBsZVBhcnNlcihzZXJpYWxpemVyKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICBwb3NpdGlvbjogdG9rZW4ucG9zaXRpb24sXHJcbiAgICAgICAgICAgIGVycm9yOiAnVW5leHBlY3RlZCB0b2tlbiB3aGVuIGRlc2NyaWJpbmcgdHlwZTogXCInICsgdG9rZW4udmFsdWUgKyAnXCInLFxyXG4gICAgICAgIH07XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBwYXJzZXIgPSBmdW5jdGlvbiAodG9rZW5zLCBzb3VyY2UpIHtcclxuICAgICAgICB2YXIgc2VyaWFsaXplciA9IG5ldyBnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24uU2VyaWFsaXplcih0b2tlbnMpO1xyXG4gICAgICAgIHZhciBzdHJ1Y3R1cmVzID0gW107XHJcbiAgICAgICAgd2hpbGUgKHNlcmlhbGl6ZXIuaW5kZXggPCBzZXJpYWxpemVyLmRhdGFWaWV3Lmxlbmd0aCkge1xyXG4gICAgICAgICAgICB2YXIgbmFtZSA9IG5hbWVQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgIGlmIChuYW1lWzBdICE9PSBuYW1lWzBdLnRvVXBwZXJDYXNlKCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IHtcclxuICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogLTEsXHJcbiAgICAgICAgICAgICAgICAgICAgZXJyb3I6ICdTdHJ1Y3R1cmUgbmFtZXMgY2Fubm90IHN0YXJ0IHdpdGggbG93ZXJjYXNlIGxldHRlcnMnLFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdW1lU3ltYm9sKHNlcmlhbGl6ZXIsICc9Jyk7XHJcbiAgICAgICAgICAgIHZhciB2YWx1ZSA9IHR5cGVQYXJzZXIoc2VyaWFsaXplcik7XHJcbiAgICAgICAgICAgIGNvbnN1bWVTeW1ib2woc2VyaWFsaXplciwgJzsnKTtcclxuICAgICAgICAgICAgc3RydWN0dXJlcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgIG5hbWU6IG5hbWUsXHJcbiAgICAgICAgICAgICAgICB2YWx1ZTogdmFsdWUsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gc3RydWN0dXJlcztcclxuICAgIH07XHJcblxyXG4gICAgdmFyIGNyZWF0ZUhhbmRsZXJzID0gZnVuY3Rpb24gKHN0cnVjdHVyZSkge1xyXG4gICAgICAgIHZhciBsaWJyYXJ5ID0ge307XHJcbiAgICAgICAgc3RydWN0dXJlLmZvckVhY2goZnVuY3Rpb24gKGVudHJ5KSB7XHJcbiAgICAgICAgICAgIGxpYnJhcnlbZW50cnkubmFtZV0gPSBlbnRyeS52YWx1ZS5nZW5lcmF0ZUhhbmRsZXIobGlicmFyeSk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmV0dXJuIGxpYnJhcnk7XHJcbiAgICB9O1xyXG5cclxuICAgIHZhciBwYXJzZSA9IGZ1bmN0aW9uICh0ZXh0KSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcmV0dXJuIGNyZWF0ZUhhbmRsZXJzKHBhcnNlcihsZXhlcih0b2tlbml6ZXIodGV4dCksIHRleHQpLCB0ZXh0KSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihlcnIuZXJyb3IpO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgaWYgKCFnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24pIHtcclxuICAgICAgICBnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24gPSB7fTtcclxuICAgIH1cclxuXHJcbiAgICBnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24uX3BhcnNlclN0ZXBzID0ge1xyXG4gICAgICAgIHRva2VuaXplcjogdG9rZW5pemVyLFxyXG4gICAgICAgIGxleGVyOiBsZXhlcixcclxuICAgICAgICBwYXJzZXI6IHBhcnNlcixcclxuICAgICAgICBUb2tlbkNhdGVnb3JpZXM6IFRva2VuQ2F0ZWdvcmllcyxcclxuICAgICAgICBUeXBlQ2F0ZWdvcmllczogVHlwZUNhdGVnb3JpZXMsXHJcbiAgICAgICAgU3RyaW5nVG9rZW46IFN0cmluZ1Rva2VuLFxyXG4gICAgICAgIFRva2VuOiBUb2tlbixcclxuICAgICAgICBUeXBlOiBUeXBlLFxyXG4gICAgfTtcclxuXHJcbiAgICBnbG9iYWwuRmx5YnJpeFNlcmlhbGl6YXRpb24ucGFyc2UgPSBwYXJzZTtcclxuXHJcbn0odGhpcykpO1xyXG4iLCIoZnVuY3Rpb24gKGdsb2JhbCkge1xyXG4gICAgJ3VzZSBzdHJpY3QnO1xyXG5cclxuICAgIGZ1bmN0aW9uIFNlcmlhbGl6ZXIoZGF0YVZpZXcpIHtcclxuICAgICAgICB0aGlzLmluZGV4ID0gMDtcclxuICAgICAgICB0aGlzLmRhdGFWaWV3ID0gZGF0YVZpZXc7XHJcbiAgICB9XHJcblxyXG4gICAgU2VyaWFsaXplci5wcm90b3R5cGUuYWRkID0gZnVuY3Rpb24gKGluY3JlbWVudCkge1xyXG4gICAgICAgIHRoaXMuaW5kZXggKz0gaW5jcmVtZW50O1xyXG4gICAgfTtcclxuXHJcbiAgICBpZiAoIWdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbikge1xyXG4gICAgICAgIGdsb2JhbC5GbHlicml4U2VyaWFsaXphdGlvbiA9IHt9O1xyXG4gICAgfVxyXG4gICAgZ2xvYmFsLkZseWJyaXhTZXJpYWxpemF0aW9uLlNlcmlhbGl6ZXIgPSBTZXJpYWxpemVyO1xyXG5cclxufSh0aGlzKSk7XHJcbiJdfQ==
