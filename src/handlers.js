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

    var hasBit = function (mask, idx) {
        return (mask & (1 << idx)) !== 0;
    };

    var emptyNumeric = function () {
        return 0;
    };

    var createNumericType = function (key, byteCount) {
        var encode = function (serializer, data) {
            serializer.dataView['set' + key](serializer.index, data, 1);
            serializer.add(byteCount);
        };

        var decode = function (serializer) {
            var data = serializer.dataView['get' + key](serializer.index, 1);
            serializer.add(byteCount);
            return data;
        };

        return new Handler(byteCount, emptyNumeric, encode, decode);
    };

    handlers.u8 = createNumericType('Uint8', 1);
    handlers.u16 = createNumericType('Uint16', 2);
    handlers.u32 = createNumericType('Uint32', 4);
    handlers.i8 = createNumericType('Int8', 1);
    handlers.i16 = createNumericType('Int16', 2);
    handlers.i32 = createNumericType('Int32', 4);
    handlers.f32 = createNumericType('Float32', 4);
    handlers.f64 = createNumericType('Float64', 8);

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
            children.forEach(function (child, idx) {
                child.encode(serializer, data[idx], masks && masks[idx]);
            });
        };
        var decode = function (serializer) {
            return children.map(function (child) {
                return child.decode(serializer);
            });
        };
        var encodeFixed = function (serializer, data) {
            children.forEach(function (child, idx) {
                child.encodeFixed(serializer, data[idx]);
            });
        };
        var decodeFixed = function (serializer) {
            return children.map(function (child) {
                return child.decodeFixed(serializer);
            });
        };
        var empty = function () {
            return children.map(function (child) {
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
            result.MASK = mask;
            return mask;
        };
        var encodeFixed = function (serializer, data) {
            children.forEach(function (child, idx) {
                child.encodeFixed(serializer, data[idx]);
            });
        };
        var decodeFixed = function (serializer) {
            return children.map(function (child) {
                return child.decodeFixed(serializer);
            });
        };
        var empty = function () {
            var result = children.map(function (child) {
                return child.empty();
            });
            result.MASK = Math.pow(2, children.length) - 1;
            return result;
        };
        var byteCount = children.reduce(function (accum, child) {
            return accum + child.byteCount;
        }, 0);
        return new Handler(byteCount, empty, encode, decode, encodeFixed, decodeFixed);
    };

    handlers.mapUnmasked = function (children) {
        var encode = function (serializer, data, masks) {
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
        var encodeFixed = function (serializer, data) {
            children.forEach(function (child) {
                child.handler.encodeFixed(serializer, data[child.key]);
            });
        };
        var decodeFixed = function (serializer) {
            var result = {};
            children.forEach(function (child) {
                result[child.key] = child.handler.decodeFixed(serializer);
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
                children.forEach(function (_, idx) {
                    var value = data[idx];
                    if (value !== null && value !== undefined) {
                        mask |= 1 << idx;
                    }
                });
            }
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
                    result[child.key] = child.decode(serializer);
                } else {
                    result[child.key] = null;
                }
            });
            result.MASK = mask;
            return mask;
        };
        var encodeFixed = function (serializer, data) {
            children.forEach(function (child) {
                child.handler.encodeFixed(serializer, data[child.key]);
            });
        };
        var decodeFixed = function (serializer) {
            var result = {};
            children.forEach(function (child) {
                result[child.key] = child.handler.decodeFixed(serializer);
            });
            return result;
        };
        var empty = function () {
            var result = {};
            children.forEach(function (child) {
                result[child.key] = child.handler.empty();
            });
            result.MASK = Math.pow(2, children.length) - 1;
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
