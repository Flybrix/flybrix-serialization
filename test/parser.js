describe('Parser', function () {
    beforeEach(function () {
        var steps = FlybrixSerialization._parserSteps;
        this.tokenizer = steps.tokenizer;
        this.lexer = steps.lexer;
        this.parser = steps.parser;
        this.StringToken = steps.StringToken;
        this.Token = steps.Token;
        this.TokenCategories = steps.TokenCategories;
        this.parse = FlybrixSerialization.parse;
    });

    describe('tokenizer', function () {
        it('exists', function () {
            expect(this.tokenizer).toBeDefined();
        });

        it('is a function', function () {
            expect(typeof this.tokenizer).toBe('function');
        });

        it('rejects invalid characters', function () {
            var tokenizer = this.tokenizer;

            expect(function () {
                tokenizer('Foo = { bar: u8, baz: v7[44}]/\n\r\t//()::;,');
            }).not.toThrow();

            expect(function () {
                tokenizer('\\$%^');
            }).toThrow();
        });

        it('splits into relevant symbols and strings', function () {
            var tokens = this.tokenizer('Foo = { bar: u8, baz: v7[44}]/\n\r\t//()::;,');

            expect(tokens.map(function (v) {
                return v.value;
            })).toEqual(
                ['Foo', '=', '{', 'bar', ':', 'u8', ',', 'baz', ':', 'v7', '[',
                    '44', '}', ']', '/', '/', '/', '(', ')', ':', ':', ';', ',']
            );

            expect(tokens.map(function (v) {
                return v.position;
            })).toEqual(
                [0, 4, 6, 8, 11, 13, 15, 17, 20, 22, 24,
                    25, 27, 28, 29, 33, 34, 35, 36, 37, 38, 39, 40]
            );
        });
    });

    describe('lexer', function () {
        it('exists', function () {
            expect(this.lexer).toBeDefined();
        });

        it('is a function', function () {
            expect(typeof this.lexer).toBe('function');
        });

        it('splits into relevant symbols and strings', function () {
            var StringToken = this.StringToken;
            var name = this.TokenCategories.NAME;
            var num = this.TokenCategories.NUMBER;
            var sym = this.TokenCategories.SYMBOL;
            var tokens = this.lexer([
                new StringToken(0, 'Foo'),
                new StringToken(4, '='),
                new StringToken(6, '{'),
                new StringToken(8, 'bar'),
                new StringToken(11, ':'),
                new StringToken(13, 'u8'),
                new StringToken(15, ','),
                new StringToken(17, 'baz'),
                new StringToken(20, ':'),
                new StringToken(22, 'v7'),
                new StringToken(24, '['),
                new StringToken(25, '44'),
                new StringToken(27, '}'),
                new StringToken(28, ']'),
                new StringToken(29, '/'),
                new StringToken(33, '/'),
                new StringToken(34, '/'),
                new StringToken(35, '('),
                new StringToken(36, ')'),
                new StringToken(37, ':'),
                new StringToken(38, ':'),
                new StringToken(39, ';'),
                new StringToken(40, ','),
            ]);

            expect(tokens.map(function (v) {
                return v.value;
            })).toEqual(
                ['Foo', '=', '{', 'bar', ':', 'u8', ',', 'baz', ':', 'v7', '[',
                    44, '}', ']', '/', '/', '/', '(', ')', ':', ':', ';', ',']
            );

            expect(tokens.map(function (v) {
                return v.position;
            })).toEqual(
                [0, 4, 6, 8, 11, 13, 15, 17, 20, 22, 24,
                    25, 27, 28, 29, 33, 34, 35, 36, 37, 38, 39, 40]
            );

            expect(tokens.map(function (v) {
                return v.category;
            })).toEqual(
                [name, sym, sym, name, sym, name, sym, name, sym, name, sym,
                    num, sym, sym, sym, sym, sym, sym, sym, sym, sym, sym, sym]
            );
        });
    });

    describe('parse', function () {
        it('handles one name alias', function () {
            var handlers = this.parse('V=u8;');
            expect(Object.keys(handlers).sort()).toEqual(['V']);
            expect(handlers.V.descriptor).toBe('u8');
        });

        it('handles multiple name aliases', function () {
            var handlers = this.parse(
                'Vu8=u8;' +
                'Vu16=u16;' +
                'Vu32=u32;' +
                'Vi8=i8;' +
                'Vi16=i16;' +
                'Vi32=i32;' +
                'Vf32=f32;' +
                'Vf64=f64;' +
                'Vs12=s12;' +
                'Vs3=s3;' +
                'Vindirect=Vs12;' +
                'Vindirecter=Vindirect;');
            expect(Object.keys(handlers).sort()).toEqual([
                'Vf32', 'Vf64',
                'Vi16', 'Vi32', 'Vi8',
                'Vindirect', 'Vindirecter',
                'Vs12', 'Vs3',
                'Vu16', 'Vu32', 'Vu8']);
            expect(handlers.Vu8.descriptor).toBe('u8');
            expect(handlers.Vu16.descriptor).toBe('u16');
            expect(handlers.Vu32.descriptor).toBe('u32');
            expect(handlers.Vi8.descriptor).toBe('i8');
            expect(handlers.Vi16.descriptor).toBe('i16');
            expect(handlers.Vi32.descriptor).toBe('i32');
            expect(handlers.Vf32.descriptor).toBe('f32');
            expect(handlers.Vf64.descriptor).toBe('f64');
            expect(handlers.Vs12.descriptor).toBe('s12');
            expect(handlers.Vs3.descriptor).toBe('s3');
            expect(handlers.Vindirect.descriptor).toBe('s12');
            expect(handlers.Vindirecter.descriptor).toBe('s12');
        });

        it('handles arrays', function () {
            expect(this.parse('V=[u8:12];').V.descriptor).toBe('[u8:12]');
        });

        it('handles masked arrays', function () {
            expect(this.parse('V=[//u8:12];').V.descriptor).toBe('[/16/u8:12]');
            expect(this.parse('V=[/20/u8:12];').V.descriptor).toBe('[/24/u8:12]');
        });

        it('handles tuples', function () {
            expect(this.parse('V=(u8,i16,s4);').V.descriptor).toBe('(u8,i16,s4)');
        });

        it('handles masked tuples', function () {
            expect(this.parse('V=(//u8,i16,s4);').V.descriptor).toBe('(/8/u8,i16,s4)');
            expect(this.parse('V=(/20/u8,i16,s4);').V.descriptor).toBe('(/24/u8,i16,s4)');
        });

        it('handles structures', function () {
            expect(this.parse('V={a:u8,b:u16,c:s32};').V.descriptor).toBe('{a:u8,b:u16,c:s32}');
        });

        it('handles masked structures', function () {
            expect(this.parse('V={//a:u8,b:u16,c:s32};').V.descriptor).toBe('{/8/a:u8,b:u16,c:s32}');
            expect(this.parse('V={/10/a:u8,b:u16,c:s32};').V.descriptor).toBe('{/16/a:u8,b:u16,c:s32}');
        });

        it('handles a config', function () {
            var text = '' +
                'Version = {' +
                '  major: u8,' +
                '  minor: u8,' +
                '  patch: u8' +
                '};' +
                'Vector3 = {' +
                '  x: f32,' +
                '  y: f32,' +
                '  z: f32' +
                '};' +
                'Color = {' +
                '  red: u8,' +
                '  green: u8,' +
                '  blue: u8' +
                '};' +
                'Led = {' +
                '  color1: Color,' +
                '  color2: Color,' +
                '  pattern: u8' +
                '};' +
                'Configuration = {/16/' +
                '  version: Version,' +
                '  magnetometerBias: Vector3,' +
                '  name: s,' +
                '  ledPatterns: [// Led : 16]' +
                '};' +
                'Commands = {/32/' +
                '  setConfig: Configuration,' +
                '  getConfig: {' +
                '    mainMask: u16,' +
                '    ledMask: u16' +
                '  }' +
                '};' +
                'Response = {' +
                '  requests: u32,' +
                '  successful: u32' +
                '};' +
                '';
            var handlers = this.parse(text);
            expect(Object.keys(handlers).sort()).toEqual([
                'Color',
                'Commands',
                'Configuration',
                'Led',
                'Response',
                'Vector3',
                'Version',
            ]);
            expect(handlers.Color.descriptor).toBe('{red:u8,green:u8,blue:u8}');
            expect(handlers.Version.descriptor).toBe('{major:u8,minor:u8,patch:u8}');
            expect(handlers.Vector3.descriptor).toBe('{x:f32,y:f32,z:f32}');
            expect(handlers.Response.descriptor).toBe('{requests:u32,successful:u32}');
            expect(handlers.Led.descriptor).toBe('{color1:{red:u8,green:u8,blue:u8},color2:{red:u8,green:u8,blue:u8},pattern:u8}');
            expect(handlers.Configuration.descriptor).toBe('{/16/version:{major:u8,minor:u8,patch:u8},magnetometerBias:{x:f32,y:f32,z:f32},name:s,ledPatterns:[/16/{color1:{red:u8,green:u8,blue:u8},color2:{red:u8,green:u8,blue:u8},pattern:u8}:16]}');
            expect(handlers.Commands.descriptor).toBe('{/32/setConfig:{/16/version:{major:u8,minor:u8,patch:u8},magnetometerBias:{x:f32,y:f32,z:f32},name:s,ledPatterns:[/16/{color1:{red:u8,green:u8,blue:u8},color2:{red:u8,green:u8,blue:u8},pattern:u8}:16]},getConfig:{mainMask:u16,ledMask:u16}}');
        });
    });
});
