(function (global) {
    'use strict';

    function Handler(byteCount, empty, encode, decode, encodeFixed, decodeFixed) {
        this.byteCount = byteCount;
        this.encode = encode;
        this.decode = decode;
        this.encodeFixed = encodeFixed || encode;
        this.decodeFixed = decodeFixed || decode;
        this.empty = empty;
    }

    var handlers = {};

    var primitiveNumericTypes = [];

    var emptyNumeric = function () {
        return 0;
    };

    [1, 2, 4].forEach(function (byteCount) {
        primitiveNumericTypes.push({
            short: 'u' + (byteCount * 8),
            long: 'Uint' + (byteCount * 8),
            byteCount: byteCount,
        });
    });

    [1, 2, 4].forEach(function (byteCount) {
        primitiveNumericTypes.push({
            short: 'i' + (byteCount * 8),
            long: 'Int' + (byteCount * 8),
            byteCount: byteCount,
        });
    });

    [4, 8].forEach(function (byteCount) {
        primitiveNumericTypes.push({
            short: 'f' + (byteCount * 8),
            long: 'Float' + (byteCount * 8),
            byteCount: byteCount,
        });
    });

    primitiveNumericTypes.forEach(function (typeInfo) {
        var key = typeInfo.long;
        var keyShort = typeInfo.short;
        var byteCount = typeInfo.byteCount;

        var encode = function (serializer, data) {
            serializer.dataView['set' + key](serializer.index, data, 1);
            serializer.add(byteCount);
        };

        var decode = function (serializer) {
            var data = serializer.dataView['get' + key](serializer.index, 1);
            serializer.add(byteCount);
            return data;
        };

        handlers[keyShort] = new Handler(byteCount, emptyNumeric, encode, decode);
    });

    handlers.bool = new Handler(
        handlers.u8.byteCount,
        function () {
            return false;
        },
        function (serializer, data) {
            handlers.u8.encode(serializer, data ? 1 : 0);
        },
        function (serializer) {
            return handlers.u8.decode(serializer);
        });

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
        var handler = handlers.array(length, handlers.u8);
        var encode = function (serializer, data) {
            handler.encode(serializer, asciiEncode(data, length));
        };
        var decode = function (serializer) {
            return asciiDecode(handler.decode(serializer), length);
        };
        var empty = function () {
            return '';
        };
        return new Handler(length, empty, encode, decode);
    };

    handlers.arrayUnmasked = function (length, handler) {
        var children = [];
        for (var idx = 0; idx < length; ++idx) {
            children.push(handler);
        }
        return handlers.tupleUnmasked(children);
    };

    handlers.tupleUnmasked = function (children) {
        var encode = function (serializer, data, masks) {
            children.forEach(function(child, idx) {
                child.encode(serializer, data[idx], masks && masks[idx]);
            });
        };
        var decode = function (serializer) {
            return children.map(function(child) {
                return child.decode(serializer);
            });
        };
        var encodeFixed = function (serializer, data) {
            children.forEach(function(child, idx) {
                child.encodeFixed(serializer, data[idx]);
            });
        };
        var decodeFixed = function (serializer) {
            return children.map(function(child) {
                return child.decodeFixed(serializer);
            });
        };
        var empty = function () {
            return children.map(function(child) {
                return child.empty();
            });
        };
        var byteCount = children.reduce(function (accum, child) {
            return accum + child.byteCount;
        }, 0);
        return new Handler(byteCount, empty, encode, decode, encodeFixed, decodeFixed);
    };

    handlers.arrayMasked = function (length, handler) {
        var children = [];
        for (var idx = 0; idx < length; ++idx) {
            children.push(handler);
        }
        return handlers.tupleMasked(children);
    };

    handlers.tupleMasked = function (children, maskBitcount) {
        var maskHandler = handlers['u' + maskBitcount];
        var encode = function (serializer, data, masks) {
            var mask = 0;
            if (masks && ('MASK' in masks)) {
                mask = masks.MASK;
            } else if ('MASK' in data) {
                mask = data.MASK;
            } else {
                children.forEach(function (_, idx) {
                    var value = data[idx];
                    if (value !== null && value !== undefined) {
                        mask |= 1 << idx;
                    }
                });
            }
            maskHandler.encode(serializer, mask);
            children.forEach(function(child, idx) {
                if (mask & (1 << idx)) {
                    child.encode(serializer, data[idx], masks && masks[idx]);
                }
            });
        };
        var decode = function (serializer) {
            var mask = maskHandler.decode(serializer);
            var result = children.map(function(child, idx) {
                if (mask & (1 << idx)) {
                    return child.decode(serializer);
                }
                return null;
            });
            result.MASK = mask;
            return mask;
        };
        var encodeFixed = function (serializer, data) {
            children.forEach(function(child, idx) {
                child.encodeFixed(serializer, data[idx]);
            });
        };
        var decodeFixed = function (serializer) {
            return children.map(function(child) {
                return child.decodeFixed(serializer);
            });
        };
        var empty = function () {
            return children.map(function(child) {
                return child.empty();
            });
        };
        var byteCount = children.reduce(function (accum, child) {
            return accum + child.byteCount;
        }, 0);
        return new Handler(byteCount, empty, encode, decode, encodeFixed, decodeFixed);
    };

    handlers.mapUnmasked = function (children) {
        var encode = function (serializer, data, masks) {
            children.forEach(function(child) {
                child.handler.encode(serializer, data[child.key], masks && masks[child.key]);
            });
        };
        var decode = function (serializer) {
            var result = {};
            children.forEach(function(child) {
                result[child.key] = child.handler.decode(serializer);
            });
            return result;
        };
        var encodeFixed = function (serializer, data) {
            children.forEach(function(child) {
                child.handler.encodeFixed(serializer, data[child.key]);
            });
        };
        var decodeFixed = function (serializer) {
            var result = {};
            children.forEach(function(child) {
                result[child.key] = child.handler.decodeFixed(serializer);
            });
            return result;
        };
        var empty = function () {
            var result = {};
            children.forEach(function(child) {
                result[child.key] = child.empty();
            });
            return result;
        };
        var byteCount = children.reduce(function (accum, child) {
            return accum + child.handler.byteCount;
        }, 0);
        return new Handler(byteCount, empty, encode, decode, encodeFixed, decodeFixed);
    };

    handlers.mapMasked = function (children, maskBitcount) {
        var maskHandler = handlers['u' + maskBitcount];
        var encode = function (serializer, data, masks) {
            var mask = 0;
            if (masks && ('MASK' in masks)) {
                mask = masks.MASK;
            } else if ('MASK' in data) {
                mask = data.MASK;
            } else {
                var antiMask = 0;
                children.forEach(function (_, idx) {
                    var value = data[idx];
                    if (value !== null && value !== undefined) {
                        mask |= 1 << idx;
                    } else {
                        antiMask |= 1 << idx;
                    }
                });
                mask &= ~antiMask;
            }
            maskHandler.encode(serializer, mask);
            children.forEach(function(child, idx) {
                if (mask & (1 << idx)) {
                    child.handler.encode(serializer, data[child.key], masks && masks[child.key]);
                }
            });
        };
        var decode = function (serializer) {
            var mask = maskHandler.decode(serializer);
            var result = {};
            children.forEach(function(child, idx) {
                if (mask & (1 << idx)) {
                    result[child.key] = child.decode(serializer);
                } else {
                    result[child.key] = null;
                }
            });
            result.MASK = mask;
            return mask;
        };
        var encodeFixed = function (serializer, data) {
            children.forEach(function(child) {
                child.handler.encodeFixed(serializer, data[child.key]);
            });
        };
        var decodeFixed = function (serializer) {
            var result = {};
            children.forEach(function(child) {
                result[child.key] = child.handler.decodeFixed(serializer);
            });
            return result;
        };
        var empty = function () {
            var result = {};
            children.forEach(function(child) {
                result[child.key] = child.empty();
            });
            return result;
        };
        var byteCount = children.reduce(function (accum, child) {
            return accum + child.handler.byteCount;
        }, 0);
        return new Handler(byteCount, empty, encode, decode, encodeFixed, decodeFixed);
    };

    if (!global.FlybrixSerialization) {
        global.FlybrixSerialization = {};
    }
    global.FlybrixSerialization._handlers = handlers;

}(this));
