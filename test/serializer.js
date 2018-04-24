describe('Serializer', function () {
    'use strict';

    it('exists', function () {
        expect(FlybrixSerialization.Serializer).toBeDefined();
    });

    it('is a function', function () {
        expect(typeof FlybrixSerialization.Serializer).toBe('function');
    });

    describe('instance', function () {
        beforeEach(function () {
            this.instance = new FlybrixSerialization.Serializer('');
        });

        it('is object with index and passed data view, and add method', function () {
            var value = new FlybrixSerialization.Serializer('foo');
            expect(typeof value).toBe('object');
            expect(value.dataView).toBe('foo');
            expect(typeof value.add).toBe('function');
        });

        it('index starts at zero', function () {
            expect(this.instance.index).toBe(0);
        });

        it('add increments index by passed value', function () {
            expect(this.instance.index).toBe(0);
            this.instance.add(5);
            expect(this.instance.index).toBe(5);
            this.instance.add(3);
            expect(this.instance.index).toBe(8);
        });
    });
});
