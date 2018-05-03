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
