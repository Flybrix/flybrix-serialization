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
