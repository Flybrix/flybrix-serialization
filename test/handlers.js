describe('Handlers', function () {
    beforeEach(function () {
        this.handlers = FlybrixSerialization._handlers;
        this.Serializer = FlybrixSerialization.Serializer;
    });

    it('exist', function () {
        expect(this.handlers).toBeDefined();
    });

    describe('empty', function () {
        it('is false for bool', function () {
            expect(this.handlers.bool.empty()).toEqual(false);
        });

        it('is zero for number', function () {
            expect(this.handlers.f64.empty()).toEqual(0);
        });

        it('is empty string for string', function () {
            expect(this.handlers.string(5).empty()).toEqual('');
        });

        it('is array of empties for array', function () {
            expect(this.handlers.arrayUnmasked(3, this.handlers.bool).empty()).toEqual([
                false, false, false
            ]);
        });

        it('is array of empties for masked array', function () {
            var value = this.handlers.arrayMasked(3, this.handlers.bool).empty();
            expect(value).toEqual([false, false, false]);
        });

        it('is array of empties for tuple', function () {
            expect(this.handlers.tupleUnmasked([this.handlers.bool, this.handlers.string(2)]).empty())
                .toEqual([false, '']);
        });

        it('is array of empties for masked tuple', function () {
            var value = this.handlers.tupleMasked([this.handlers.bool, this.handlers.string(2)]).empty();
            expect(value).toEqual([false, '']);
        });

        it('is map of empties for map', function () {
            expect(this.handlers
                .mapUnmasked([
                    {key: 'name', handler: this.handlers.string(9)},
                    {key: 'price', handler: this.handlers.u32},
                ])
                .empty())
                .toEqual({
                    name: '',
                    price: 0,
                });
        });

        it('is map of empties for masked map', function () {
            expect(this.handlers
                .mapMasked([
                    {key: 'name', handler: this.handlers.string(9)},
                    {key: 'price', handler: this.handlers.u32},
                ])
                .empty())
                .toEqual({
                    name: '',
                    price: 0,
                });
        });
    });

    describe('fullMask', function () {
        it('is null for bool', function () {
            expect(this.handlers.bool.fullMask()).toEqual(null);
        });

        it('is null for number', function () {
            expect(this.handlers.f64.fullMask()).toEqual(null);
        });

        it('is null string for string', function () {
            expect(this.handlers.string(5).fullMask()).toEqual(null);
        });

        it('is null for array of unmasked values', function () {
            expect(this.handlers.arrayUnmasked(3, this.handlers.bool).fullMask()).toEqual(null);
        });

        it('is map of children masks for array of masked values', function () {
            var child = this.handlers.arrayMasked(4, this.handlers.bool);
            var childMask = child.fullMask();
            expect(this.handlers.arrayUnmasked(3, child).fullMask()).toEqual({
                0: childMask,
                1: childMask,
                2: childMask,
            });
        });

        it('is map of children masks with mask field for masked array', function () {
            var value = this.handlers.arrayMasked(3, this.handlers.bool).fullMask();
            expect(value).toEqual({
                MASK: [true, true, true],
            });
        });

        it('is null for tuple of unmasked values', function () {
            expect(this.handlers.tupleUnmasked([this.handlers.bool, this.handlers.u8]).fullMask()).toEqual(null);
        });

        it('is map of children masks for tuple of masked values', function () {
            var child = this.handlers.arrayMasked(4, this.handlers.bool);
            var childMask = child.fullMask();
            expect(this.handlers.tupleUnmasked([this.handlers.bool, child, child]).fullMask()).toEqual({
                1: childMask,
                2: childMask,
            });
        });

        it('is map of children masks with mask field for masked tuple', function () {
            var child = this.handlers.arrayMasked(4, this.handlers.bool);
            var childMask = child.fullMask();
            var value = this.handlers.tupleMasked([this.handlers.bool, child]).fullMask();
            expect(value).toEqual({
                1: childMask,
                MASK: [true, true],
            });
        });

        it('is null for map of unmasked values', function () {
            expect(this.handlers
                .mapUnmasked([
                    {key: 'name', handler: this.handlers.string(9)},
                    {key: 'price', handler: this.handlers.u32},
                ])
                .fullMask())
                .toEqual(null);
        });

        it('is map of non-null children masks for map of masked values', function () {
            var child = this.handlers.arrayMasked(4, this.handlers.bool);
            var childMask = child.fullMask();
            expect(this.handlers
                .mapUnmasked([
                    {key: 'name', handler: child},
                    {key: 'price', handler: this.handlers.u32},
                ])
                .fullMask())
                .toEqual({
                    name: childMask,
                });
        });

        it('is map of non-null children masks with mask field for masked map', function () {
            var child = this.handlers.arrayMasked(4, this.handlers.bool);
            var childMask = child.fullMask();

            expect(this.handlers
                .mapMasked([
                    {key: 'name', handler: child},
                    {key: 'price', handler: this.handlers.u32},
                ])
                .fullMask())
                .toEqual({
                    name: childMask,
                    MASK: {
                        name: true,
                        price: true,
                    },
                });
        });
    });

    describe('boolean', function () {
        beforeEach(function () {
            this.handler = this.handlers.bool;
        });

        it('encodes true', function () {
            var data = new Uint8Array(1);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, true);
            expect(data).toEqual(new Uint8Array([1]));
        });

        it('encodes false', function () {
            var data = new Uint8Array(1);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, false);
            expect(data).toEqual(new Uint8Array([0]));
        });

        it('has right amount of bytes', function () {
            expect(this.handler.byteCount).toBe(1);
        });

        it('decodes true', function () {
            var data = new Uint8Array([5]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            expect(this.handler.decode(b)).toEqual(true);
        });

        it('decodes false', function () {
            var data = new Uint8Array([0]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            expect(this.handler.decode(b)).toEqual(false);
        });

        it('has the correct descriptor', function () {
            expect(this.handler.descriptor).toBe('bool');
        });
    });

    describe('number', function () {
        it('encodes Uint8', function () {
            var data = new Uint8Array(1);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.u8;
            encoder.encode(b, 180);
            expect(data).toEqual(new Uint8Array([180]));
        });

        it('encodes Uint16', function () {
            var data = new Uint8Array(2);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.u16;
            encoder.encode(b, 0xF00D);
            expect(data).toEqual(new Uint8Array([0x0D, 0xF0]));
        });

        it('encodes Uint32', function () {
            var data = new Uint8Array(4);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.u32;
            encoder.encode(b, 0xF00DD33D);
            expect(data).toEqual(new Uint8Array([0x3D, 0xD3, 0x0D, 0xF0]));
        });

        it('encodes Int8', function () {
            var data = new Uint8Array(1);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.i8;
            encoder.encode(b, -100);
            expect(data).toEqual(new Uint8Array([156]));
        });

        it('encodes Int16', function () {
            var data = new Uint8Array(2);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.i16;
            encoder.encode(b, -10000);
            expect(data).toEqual(new Uint8Array([240, 216]));
        });

        it('encodes Int32', function () {
            var data = new Uint8Array(4);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.i32;
            encoder.encode(b, -1000000000);
            expect(data).toEqual(new Uint8Array([0x00, 0x36, 0x65, 0xC4]));
        });

        it('encodes Float32', function () {
            var data = new Uint8Array(4);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.f32;
            encoder.encode(b, 1005.75);
            expect(data).toEqual(new Uint8Array([0x00, 0x70, 0x7b, 0x44]));
        });

        it('encodes Float64', function () {
            var data = new Uint8Array(8);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.f64;
            encoder.encode(b, 1005.75);
            expect(data).toEqual(new Uint8Array(
                [0x00, 0x00, 0x00, 0x00, 0x00, 0x6e, 0x8f, 0x40]));
        });

        it('has right amount of bytes', function () {
            expect(this.handlers.u8.byteCount).toBe(1);
            expect(this.handlers.u16.byteCount).toBe(2);
            expect(this.handlers.u32.byteCount).toBe(4);
            expect(this.handlers.i8.byteCount).toBe(1);
            expect(this.handlers.i16.byteCount).toBe(2);
            expect(this.handlers.i32.byteCount).toBe(4);
            expect(this.handlers.f32.byteCount).toBe(4);
            expect(this.handlers.f64.byteCount).toBe(8);
        });

        it('decodes Uint8', function () {
            var data = new Uint8Array([180]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.u8;
            expect(encoder.decode(b)).toEqual(180);
        });

        it('decodes Uint16', function () {
            var data = new Uint8Array([0x0D, 0xF0]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.u16;
            expect(encoder.decode(b)).toEqual(0xF00D);
        });

        it('decodes Uint32', function () {
            var data = new Uint8Array([0x3D, 0xD3, 0x0D, 0xF0]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.u32;
            expect(encoder.decode(b)).toEqual(0xF00DD33D);
        });

        it('decodes Int8', function () {
            var data = new Uint8Array([156]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.i8;
            expect(encoder.decode(b)).toEqual(-100);
        });

        it('decodes Int16', function () {
            var data = new Uint8Array([240, 216]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.i16;
            expect(encoder.decode(b)).toEqual(-10000);
        });

        it('decodes Int32', function () {
            var data = new Uint8Array([0x00, 0x36, 0x65, 0xC4]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.i32;
            expect(encoder.decode(b)).toEqual(-1000000000);
        });

        it('decodes Float32', function () {
            var data = new Uint8Array([0x00, 0x70, 0x7b, 0x44]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.f32;
            expect(encoder.decode(b)).toEqual(1005.75);
        });

        it('decodes Float64', function () {
            var data = new Uint8Array(
                [0x00, 0x00, 0x00, 0x00, 0x00, 0x6e, 0x8f, 0x40]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.f64;
            expect(encoder.decode(b)).toEqual(1005.75);
        });

        it('has the correct descriptor', function () {
            expect(this.handlers.u8.descriptor).toBe('u8');
            expect(this.handlers.u16.descriptor).toBe('u16');
            expect(this.handlers.u32.descriptor).toBe('u32');
            expect(this.handlers.i8.descriptor).toBe('i8');
            expect(this.handlers.i16.descriptor).toBe('i16');
            expect(this.handlers.i32.descriptor).toBe('i32');
            expect(this.handlers.f32.descriptor).toBe('f32');
            expect(this.handlers.f64.descriptor).toBe('f64');
        });
    });

    describe('string', function () {
        it('encodes short string', function () {
            var data = new Uint8Array(9);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.string(9);
            encoder.encode(b, 'Abcd');
            expect(data).toEqual(
                new Uint8Array([65, 98, 99, 100, 0, 0, 0, 0, 0]));
        });

        it('encodes overflowed string with null terminator', function () {
            var data = new Uint8Array(6);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.string(6);
            encoder.encode(b, 'Abc0123456');
            expect(data).toEqual(new Uint8Array([65, 98, 99, 48, 49, 0]));
        });

        it('has right amount of bytes', function () {
            var encoder = this.handlers.string(9);
            expect(encoder.byteCount).toBe(9);
        });

        it('decodes short string', function () {
            var data = new Uint8Array([65, 98, 99, 100, 0, 0, 0, 48, 49]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.string(9);
            expect(encoder.decode(b)).toEqual('Abcd');
        });

        it('decodes unterminated string by trimming the end', function () {
            var data = new Uint8Array([65, 98, 99, 48, 49, 50]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            var encoder = this.handlers.string(6);
            expect(encoder.decode(b)).toEqual('Abc01');
        });

        it('has the correct descriptor', function () {
            expect(this.handlers.string(12).descriptor).toBe('s12');
            expect(this.handlers.string(3).descriptor).toBe('s3');
            expect(this.handlers.string(9).descriptor).toBe('s9');
        });
    });

    describe('s', function () {
        it('encodes short string', function () {
            var data = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 1]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            this.handlers.s.encode(b, 'Abcd');
            expect(data).toEqual(
                new Uint8Array([65, 98, 99, 100, 0, 1, 1, 1, 1]));
        });

        it('encodes exactly long string', function () {
            var data = new Uint8Array(9);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            this.handlers.s.encode(b, '012345678');
            expect(data).toEqual(
                new Uint8Array([48, 49, 50, 51, 52, 53, 54, 55, 56]));
        });

        it('encodes too long string', function () {
            var data = new Uint8Array(9);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            this.handlers.s.encode(b, '01234567890123456789');
            expect(data).toEqual(
                new Uint8Array([48, 49, 50, 51, 52, 53, 54, 55, 56]));
        });

        it('has 0 bytes in byte count', function () {
            expect(this.handlers.s.byteCount).toBe(0);
        });

        it('decodes short string', function () {
            var data = new Uint8Array([65, 98, 99, 100, 0, 0, 0, 48, 49]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            expect(this.handlers.s.decode(b)).toEqual('Abcd');
        });

        it('decodes unterminated string by trimming the end', function () {
            var data = new Uint8Array([65, 98, 99, 48, 49, 50]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            expect(this.handlers.s.decode(b)).toEqual('Abc012');
        });

        it('has the correct descriptor', function () {
            expect(this.handlers.s.descriptor).toBe('s');
        });
    });

    describe('map without masking', function () {
        beforeEach(function () {
            this.handler = this.handlers.mapUnmasked([
                {key: 'a', handler: this.handlers.arrayMasked(4, this.handlers.u8, 8)},
                {key: 'b', handler: this.handlers.string(5)},
                {key: 'c', handler: this.handlers.arrayUnmasked(4, this.handlers.u8)},
            ]);
        });

        it('has the correct descriptor', function () {
            expect(this.handler.descriptor).toBe('{a:[/8/u8:4],b:s5,c:[u8:4]}');
        });

        it('encodes any data without mask field', function () {
            var data = new Uint8Array(12);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, {
                a: [0, 1, null, null],
                b: 'abcd',
                c: [4, 5, 6, 7],
            });
            expect(data).toEqual(new Uint8Array(
                [3, 0, 1, 97, 98, 99, 100, 0, 4, 5, 6, 7]));
        });

        it('encodes any data with mask field', function () {
            data = new Uint8Array(12);
            b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, {
                a: [0, 1, null, 3],
                b: 'abcd',
                c: [4, 5, 6, 7],
            }, {
                a: {
                    MASK: [true, true, true, false],
                },
            });
            expect(data).toEqual(new Uint8Array(
                [3, 0, 1, 97, 98, 99, 100, 0, 4, 5, 6, 7]));
        });

        it('has right amount of bytes', function () {
            expect(this.handler.byteCount).toBe(14);
        });

        it('decodes any data', function () {
            var data = new Uint8Array([3, 0, 1, 97, 98, 99, 100, 0, 4, 5, 6, 7]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            expect(this.handler.decode(b)).toEqual({
                a: [0, 1, null, null],
                b: 'abcd',
                c: [4, 5, 6, 7],
            });
        });
    });

    describe('map with masking', function () {
        beforeEach(function () {
            this.handler = this.handlers.mapMasked([
                {key: 'a', handler: this.handlers.arrayMasked(4, this.handlers.u8, 8)},
                {key: 'b', handler: this.handlers.string(5)},
                {key: 'c', handler: this.handlers.arrayUnmasked(4, this.handlers.u8)},
            ], 35);
        });

        it('has the correct descriptor', function () {
            expect(this.handler.descriptor).toBe('{/40/a:[/8/u8:4],b:s5,c:[u8:4]}');
        });

        it('encodes any data without mask field', function () {
            var data = new Uint8Array(13);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, {
                a: [0, 1, null, null],
                b: 'abcd',
                c: null,
            });
            expect(data).toEqual(new Uint8Array(
                [3, 0, 0, 0, 0, 3, 0, 1, 97, 98, 99, 100, 0]));
        });

        it('encodes any data with mask field', function () {
            data = new Uint8Array(13);
            b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, {
                a: [0, 1, null, 3],
                b: 'abcd',
                c: [4, 5, 6, 7],
            }, {
                a: {
                    MASK: [true, true, true, false],
                },
                MASK: {
                    a: true,
                    b: true,
                }
            });
            expect(data).toEqual(new Uint8Array(
                [3, 0, 0, 0, 0, 3, 0, 1, 97, 98, 99, 100, 0]));
        });

        it('has right amount of bytes', function () {
            expect(this.handler.byteCount).toBe(19);
        });

        it('decodes any data', function () {
            var data = new Uint8Array([3, 0, 0, 0, 0, 3, 0, 1, 97, 98, 99, 100, 0]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            expect(this.handler.decode(b)).toEqual({
                a: [0, 1, null, null],
                b: 'abcd',
                c: null,
            });
        });
    });

    describe('tuple without masking', function () {
        beforeEach(function () {
            this.handler = this.handlers.tupleUnmasked([
                this.handlers.arrayMasked(4, this.handlers.u8, 8),
                this.handlers.string(5),
                this.handlers.arrayUnmasked(4, this.handlers.u8),
            ]);
        });

        it('has the correct descriptor', function () {
            expect(this.handler.descriptor).toBe('([/8/u8:4],s5,[u8:4])');
        });

        it('encodes any data without mask field', function () {
            var data = new Uint8Array(12);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, [
                [0, 1, null, null],
                'abcd',
                [4, 5, 6, 7],
            ]);
            expect(data).toEqual(new Uint8Array(
                [3, 0, 1, 97, 98, 99, 100, 0, 4, 5, 6, 7]));
        });

        it('encodes any data with mask field', function () {
            data = new Uint8Array(12);
            b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, [
                [0, 1, null, 3],
                'abcd',
                [4, 5, 6, 7],
            ], {
                0: {
                    MASK: [true, true, true, false],
                },
            });
            expect(data).toEqual(new Uint8Array(
                [3, 0, 1, 97, 98, 99, 100, 0, 4, 5, 6, 7]));
        });

        it('has right amount of bytes', function () {
            expect(this.handler.byteCount).toBe(14);
        });

        it('decodes any data', function () {
            var data = new Uint8Array([3, 0, 1, 97, 98, 99, 100, 0, 4, 5, 6, 7]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            expect(this.handler.decode(b)).toEqual([
                [0, 1, null, null],
                'abcd',
                [4, 5, 6, 7],
            ]);
        });
    });

    describe('tuple with masking', function () {
        beforeEach(function () {
            this.handler = this.handlers.tupleMasked([
                this.handlers.arrayMasked(4, this.handlers.u8, 8),
                this.handlers.string(5),
                this.handlers.arrayUnmasked(4, this.handlers.u8),
            ], 35);
        });

        it('has the correct descriptor', function () {
            expect(this.handler.descriptor).toBe('(/40/[/8/u8:4],s5,[u8:4])');
        });

        it('encodes any data without mask field', function () {
            var data = new Uint8Array(13);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, [
                [0, 1, null, null],
                'abcd',
                null,
            ]);
            expect(data).toEqual(new Uint8Array(
                [3, 0, 0, 0, 0, 3, 0, 1, 97, 98, 99, 100, 0]));
        });

        it('encodes any data with mask field', function () {
            data = new Uint8Array(13);
            b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, [
                [0, 1, null, 3],
                'abcd',
                [4, 5, 6, 7],
            ], {
                0: {
                    MASK: [true, true, true, false],
                },
                MASK: [true, true, false],
            });
            expect(data).toEqual(new Uint8Array(
                [3, 0, 0, 0, 0, 3, 0, 1, 97, 98, 99, 100, 0]));
        });

        it('has right amount of bytes', function () {
            expect(this.handler.byteCount).toBe(19);
        });

        it('decodes any data', function () {
            var data = new Uint8Array([3, 0, 0, 0, 0, 3, 0, 1, 97, 98, 99, 100, 0]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            expect(this.handler.decode(b)).toEqual([
                [0, 1, null, null],
                'abcd',
                null,
            ]);
        });
    });

    describe('array without masking', function () {
        beforeEach(function () {
            this.handler = this.handlers.arrayUnmasked(
                3, this.handlers.arrayMasked(4, this.handlers.u8, 8));
        });

        it('has the correct descriptor', function () {
            expect(this.handler.descriptor).toBe('[[/8/u8:4]:3]');
        });

        it('encodes any data without mask field', function () {
            var data = new Uint8Array(12);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, [
                [0, 1, null, null],
                [4, null, 6, 7],
                [8, 9, 10, 11],
            ]);
            expect(data).toEqual(new Uint8Array(
                [3, 0, 1, 13, 4, 6, 7, 15, 8, 9, 10, 11]));
        });

        it('encodes any data with mask field', function () {
            data = new Uint8Array(12);
            b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, [
                [0, 1, null, 3],
                [4, 5, 6, 7],
                [8, 9, 10, 11],
            ], {
                0: {
                    MASK: [true, true, true, false],
                },
                1: {
                    MASK: [true, false, true, true],
                },
            });
            expect(data).toEqual(new Uint8Array(
                [3, 0, 1, 13, 4, 6, 7, 15, 8, 9, 10, 11]));
        });

        it('has right amount of bytes', function () {
            expect(this.handler.byteCount).toBe(15);
        });

        it('decodes any data', function () {
            var data = new Uint8Array([3, 0, 1, 13, 4, 6, 7, 15, 8, 9, 10, 11]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            expect(this.handler.decode(b)).toEqual([
                [0, 1, null, null],
                [4, null, 6, 7],
                [8, 9, 10, 11],
            ]);
        });
    });

    describe('array with masking', function () {
        beforeEach(function () {
            this.handler = this.handlers.arrayMasked(
                3, this.handlers.arrayMasked(4, this.handlers.u8, 8), 18);
        });

        it('has the correct descriptor', function () {
            expect(this.handler.descriptor).toBe('[/24/[/8/u8:4]:3]');
        });

        it('encodes any data without mask field', function () {
            var data = new Uint8Array(11);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, [
                [0, 1, null, null],
                null,
                [8, 9, 10, 11],
            ]);
            expect(data).toEqual(new Uint8Array([5, 0, 0, 3, 0, 1, 15, 8, 9, 10, 11]));
        });

        it('encodes any data with mask field', function () {
            data = new Uint8Array(11);
            b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, [
                [0, 1, null, 3],
                [4, 5, 6, 7],
                [8, 9, 10, 11],
            ], {
                0: {
                    MASK: [true, true, true, false],
                },
                MASK: [true, false, true],
            });
            expect(data).toEqual(new Uint8Array([5, 0, 0, 3, 0, 1, 15, 8, 9, 10, 11]));
        });

        it('encodes any data with mask field, and missing fields', function () {
            data = new Uint8Array(6);
            b = new this.Serializer(new DataView(data.buffer, 0));
            this.handler.encode(b, [
                [0, 1, null, 3],
                [4, 5, 6, 7],
                null,
            ], {
                0: {
                    MASK: [true, true, true, false],
                },
                MASK: [true, false, true],
            });
            expect(data).toEqual(new Uint8Array([1, 0, 0, 3, 0, 1]));
        });

        it('has right amount of bytes', function () {
            expect(this.handler.byteCount).toBe(18);
        });

        it('decodes any data', function () {
            var data = new Uint8Array([5, 0, 0, 3, 0, 1, 15, 8, 9, 10, 11]);
            var b = new this.Serializer(new DataView(data.buffer, 0));
            expect(this.handler.decode(b)).toEqual([
                [0, 1, null, null],
                null,
                [8, 9, 10, 11],
            ]);
        });
    });
});
