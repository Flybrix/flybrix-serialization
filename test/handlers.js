describe('Handlers', function () {
    beforeEach(function () {
        this.handlers = FlybrixSerialization._handlers;
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
});
