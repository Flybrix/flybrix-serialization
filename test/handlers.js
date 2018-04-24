describe('Handlers', function () {
    beforeEach(function () {
        this.handlers = FlybrixSerialization._handlers;
    });

    it('exist', function () {
        expect(this.handlers).toBeDefined();
    });

    describe('empty value', function () {
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

        it('is array of empties with mask for masked array', function () {
            var value = this.handlers.arrayMasked(3, this.handlers.bool).empty();
            var other = [false, false, false];
            other.MASK = 7;
            expect(value).toEqual(other);
        });

        it('is array of empties for tuple', function () {
            expect(this.handlers.tupleUnmasked([this.handlers.bool, this.handlers.string(2)]).empty())
                .toEqual([false, '']);
        });

        it('is array of empties with mask for masked tuple', function () {
            var value = this.handlers.tupleMasked([this.handlers.bool, this.handlers.string(2)]).empty();
            var other = [false, ''];
            other.MASK = 3;
            expect(value).toEqual(other);
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

        it('is map of empties with mask for masked map', function () {
            expect(this.handlers
                .mapMasked([
                    {key: 'name', handler: this.handlers.string(9)},
                    {key: 'price', handler: this.handlers.u32},
                ])
                .empty())
                .toEqual({
                    MASK: 3,
                    name: '',
                    price: 0,
                });
        });
    });
});
