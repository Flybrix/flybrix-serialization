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
