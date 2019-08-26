"use strict";
var pull = require('pull-stream');
var cat = require('pull-cat');
var FlumeViewLevel = require('flumeview-level');
var sort = require('ssb-sort');
var ssbRef = require('ssb-ref');
var QuickLRU = require('quick-lru');
var isBlocking = function (obj, cb) { cb(undefined, true); };
function getTimestamp(msg) {
    var arrivalTimestamp = msg.timestamp;
    var declaredTimestamp = msg.value.timestamp;
    return Math.min(arrivalTimestamp, declaredTimestamp);
}
function getRootMsgId(msg) {
    if (msg && msg.value && msg.value.content) {
        var root = msg.value.content.root;
        if (ssbRef.isMsgId(root))
            return root;
    }
}
function buildPublicIndex(ssb) {
    return ssb._flumeUse('threads-public', FlumeViewLevel(2, function (msg, _seq) { return [
        ['any', getTimestamp(msg), getRootMsgId(msg) || msg.key],
    ]; }));
}
function buildProfilesIndex(ssb) {
    return ssb._flumeUse('threads-profiles', FlumeViewLevel(2, function (msg, _seq) { return [
        [msg.value.author, getTimestamp(msg), getRootMsgId(msg) || msg.key],
    ]; }));
}
function isValidIndexItem(item) {
    return !!item && !!item[2];
}
function isUnique(uniqueRoots) {
    return function checkIsUnique(item) {
        var rootKey = item[2];
        if (uniqueRoots.has(rootKey)) {
            return false;
        }
        else {
            uniqueRoots.add(rootKey);
            return true;
        }
    };
}
function isPublic(msg) {
    return !msg.value.content || typeof msg.value.content !== 'string';
}
function isNotMine(sbot) {
    return function isNotMineGivenSbot(msg) {
        return msg && msg.value && msg.value.author !== sbot.id;
    };
}
function materialize(sbot, cache) {
    function sbotGetWithCache(item, cb) {
        var timestamp = item[1], key = item[2];
        if (cache.has(key)) {
            cb(null, cache.get(key));
        }
        else {
            sbot.get(key, function (err, value) {
                if (err)
                    return cb(err);
                var msg = { key: key, value: value, timestamp: timestamp };
                if (msg.value)
                    cache.set(key, msg);
                cb(null, msg);
            });
        }
    }
    return function fetchMsg(item, cb) {
        sbotGetWithCache(item, function (err, msg) {
            if (err)
                return cb(null, false);
            cb(null, msg);
        });
    };
}
function hasRoot(rootKey) {
    return function (msg) {
        return msg &&
            msg.value &&
            msg.value.content &&
            msg.value.content.root &&
            msg.value.content.root === rootKey;
    };
}
function makeAllowFilter(list) {
    return function (msg) {
        return !list ||
            (msg &&
                msg.value &&
                msg.value.content &&
                msg.value.content.type &&
                list.indexOf(msg.value.content.type) > -1);
    };
}
function makeBlockFilter(list) {
    return function (msg) {
        return !list ||
            !(msg &&
                msg.value &&
                msg.value.content &&
                msg.value.content.type &&
                list.indexOf(msg.value.content.type) > -1);
    };
}
function removeMessagesFromBlocked(sbot) {
    return function (inputPullStream) {
        return pull(inputPullStream, pull.asyncMap(function (msg, cb) {
            isBlocking({ source: sbot.id, dest: msg.value.author }, function (err, blocking) {
                if (err)
                    cb(err);
                else if (blocking)
                    cb(null, null);
                else
                    cb(null, msg);
            });
        }), pull.filter());
    };
}
function makeFilter(opts) {
    var passesAllowList = makeAllowFilter(opts.allowlist);
    var passesBlockList = makeBlockFilter(opts.blocklist);
    return function (m) { return passesAllowList(m) && passesBlockList(m); };
}
function nonBlockedRootToThread(sbot, maxSize, filter) {
    return function (root, cb) {
        pull(cat([
            pull.values([root]),
            pull(sbot.backlinks.read({
                query: [{ $filter: { dest: root.key } }],
                index: 'DTA',
                live: false,
                reverse: true,
            }), pull.filter(hasRoot(root.key)), removeMessagesFromBlocked(sbot), pull.filter(filter), pull.take(maxSize)),
        ]), pull.take(maxSize + 1), pull.collect(function (err2, arr) {
            if (err2)
                return cb(err2);
            var full = arr.length <= maxSize;
            sort(arr);
            if (arr.length > maxSize && arr.length >= 3)
                arr.splice(1, 1);
            cb(null, { messages: arr, full: full });
        }));
    };
}
function rootToThread(sbot, maxSize, filter) {
    return function (root, cb) {
        isBlocking({ source: sbot.id, dest: root.value.author }, function (err, blocking) {
            if (err)
                cb(err);
            else if (blocking)
                cb(new Error('Author Blocked:' + root.value.author));
            else
                nonBlockedRootToThread(sbot, maxSize, filter)(root, cb);
        });
    };
}
function init(sbot, _config) {
    if (!sbot.backlinks || !sbot.backlinks.read) {
        throw new Error('"ssb-threads" is missing required plugin "ssb-backlinks"');
    }
    if (sbot.friends) {
        isBlocking = sbot.friends.isBlocking;
    }
    var publicIndex = buildPublicIndex(sbot);
    var profilesIndex = buildProfilesIndex(sbot);
    return {
        public: function _public(opts) {
            var lt = opts.lt;
            var reverse = opts.reverse === false ? false : true;
            var live = opts.live === true ? true : false;
            var maxThreads = opts.limit || Infinity;
            var threadMaxSize = opts.threadMaxSize || Infinity;
            var filter = makeFilter(opts);
            return pull(publicIndex.read({
                lt: ['any', lt, undefined],
                reverse: reverse,
                live: live,
                keys: true,
                values: false,
                seqs: false,
            }), pull.filter(isValidIndexItem), pull.filter(isUnique(new Set())), pull.asyncMap(materialize(sbot, new QuickLRU({ maxSize: 200 }))), pull.filter(function (x) { return x !== false; }), pull.filter(isPublic), removeMessagesFromBlocked(sbot), pull.filter(filter), pull.take(maxThreads), pull.asyncMap(nonBlockedRootToThread(sbot, threadMaxSize, filter)));
        },
        publicUpdates: function _publicUpdates(opts) {
            var filter = makeFilter(opts);
            return pull(sbot.createFeedStream({ reverse: false, old: false, live: true }), pull.filter(isNotMine(sbot)), pull.filter(isPublic), removeMessagesFromBlocked(sbot), pull.filter(filter), pull.map(function (msg) { return msg.key; }));
        },
        profile: function _profile(opts) {
            var id = opts.id;
            var lt = opts.lt;
            var reverse = opts.reverse === false ? false : true;
            var live = opts.live === true ? true : false;
            var maxThreads = opts.limit || Infinity;
            var threadMaxSize = opts.threadMaxSize || Infinity;
            var filter = makeFilter(opts);
            return pull(profilesIndex.read({
                lt: [id, lt, undefined],
                gt: [id, null, undefined],
                reverse: reverse,
                live: live,
                keys: true,
                values: false,
                seqs: false,
            }), pull.filter(isValidIndexItem), pull.filter(isUnique(new Set())), pull.asyncMap(materialize(sbot, new QuickLRU({ maxSize: 200 }))), pull.filter(function (x) { return x !== false; }), pull.filter(isPublic), removeMessagesFromBlocked(sbot), pull.filter(filter), pull.take(maxThreads), pull.asyncMap(nonBlockedRootToThread(sbot, threadMaxSize, filter)));
        },
        thread: function _thread(opts) {
            var threadMaxSize = opts.threadMaxSize || Infinity;
            var rootToMsg = function (val) { return ({
                key: opts.root,
                value: val,
                timestamp: val.timestamp,
            }); };
            if (!opts.allowlist && !opts.blocklist) {
                opts.allowlist = ['post'];
            }
            var filterPosts = makeFilter(opts);
            return pull(pull.values([opts.root]), pull.asyncMap(sbot.get.bind(sbot)), pull.map(rootToMsg), pull.asyncMap(rootToThread(sbot, threadMaxSize, filterPosts)));
        },
    };
}
module.exports = {
    name: 'threads',
    version: '2.0.0',
    manifest: {
        public: 'source',
        publicUpdates: 'source',
        profile: 'source',
        thread: 'source',
    },
    permissions: {
        master: {
            allow: ['public', 'profile', 'thread'],
        },
    },
    init: init,
};
//# sourceMappingURL=index.js.map