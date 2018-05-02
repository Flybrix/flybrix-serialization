(function () {
    'use strict';

    angular.module('flybrixSerialization', []).factory('fbSerializer', function () {
        return {
            Serializer: FlybrixSerialization.Serializer,
            createHandler: FlybrixSerialization.parse,
        };
    });
});
