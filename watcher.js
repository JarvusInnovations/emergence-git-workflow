#!/usr/bin/env node

var fsevents        = require('fsevents'),
    fs              = require('fs'),
    extend          = require('util')._extend,
    http            = require('http'),
    Agent           = require('agentkeepalive'),
    getRelativePath = require('path').relative,
    RelPathList     = require('pathspec').RelPathList,
    async           = require('async'),
    colors          = require('colors/safe'),

    config          = {
        debug:      false,
        logIgnored: false,
        localDir:   '.',

        webdav: {
            ssl: false
        },

        ignore: {
            global: [],
            watch:  [],
            sync:   [],
            git:    [],
        },

        sound: {
            error:   'Basso',
            success: 'Submarine'
        }
    },

    ignoreList      = {},
    movedOut        = null,
    DEBUG           = false,
    drainSound = null;


// Merge default configuration options with config.json if present
if (fs.existsSync(process.cwd() + '/config.json')) {
    config = extend(config, require(process.cwd() + '/config.json'));
}

// Build regular expressions from globs
for (var ignoreType in config.ignore) {
    ignoreList[ignoreType] = RelPathList.parse(config.ignore[ignoreType]);
}

function playSound(sound) {
    sound = sound || config.sound.success;
    require('child_process').spawn('afplay', ['/System/Library/Sounds/' + sound + '.aiff']);
}

function shouldIgnore(event, path) {
    var events = ['global'];

    if (typeof path !== 'string') {
        path = event;
    } else {
        events.push(event);
    }

    for (var x = 0, len = events.length; x < len; x++) {
        if (ignoreList[events[x]] && ignoreList[events[x]].matches(path)) {
            return true;
        }
    }

    if (event === 'sync') {
        // HACK: Do not try to sync files to the root directory
        return path.indexOf('/') === -1;
    }

    return false;
}

var watcher = fsevents(config.localDir),
    watcherLogStream;

if (config.watcherLog) {
    watcherLogStream = fs.createWriteStream(config.watcherLog, {flags: 'a'});
}

var keepaliveAgent = new Agent({
    maxSockets:       100,
    maxFreeSockets:   10,
    timeout:          120000,
    keepAliveTimeout: 60000
});

var q = async.queue(function (task, callback) {
    webDavRequest(task.verb, task.dst, task.src, function(err) {
        task.cb(err);
        callback();
    });
}, 1);

q.drain = function() {
    if (drainSound) {
        playSound(drainSound);
    }
};

function webDavRequest(verb, destination, file, callback) {
    var fileStream,
        request,
        headers = {};

    if (file) {
        if (/move/i.test(verb)) {
            headers['Destination'] = config.webdav.path + '/' + destination;
            destination = file;
        } else {
            fileStream = fs.createReadStream(file);
            headers['Content-Length'] = fs.statSync(file).size;
        }
    }

    request = http.request({
        host:    config.webdav.hostname,
        port:    config.webdav.ssl ? 443 : 80,
        method:  verb,
        path:    config.webdav.path + '/' + destination,
        headers: headers,
        agent:   keepaliveAgent,
        auth:    config.webdav.username + ':' + config.webdav.password
    });

    request.on("response", function (res) {
        // Ignore when a delete fails due to a 404
        if (res.statusCode >= 400 && !(verb === 'DELETE' && res.statusCode == 404) && // delete a file that doesn't exist
            !(verb === 'MKCOL' && res.statusCode == 405)  // make a directory that already exists
        ) {
            res.on('end', function () {
                callback(new Error("HTTP " + verb + " failed with code " + res.statusCode + " for " + request.path));
            });
        } else {
            res.on('end', callback);
        }

        res.resume();
    });

    request.on('error', callback);

    if (fileStream) {
        fileStream.pipe(request);
    } else {
        request.end();
    }
}

watcher.on('change', function (path, info) {
    var verb, src, dst, ignore,
        isDir = info.type === 'directory',
        relPath = getRelativePath(config.localDir, path);

    DEBUG && console.error(info);

    if (watcherLogStream) {
        watcherLogStream.write([
            Date.now(),
            info.id,
            info.event,
            info.type,
            Object.keys(info.changes).filter(function(key) { return info.changes[key]; }),
            path
        ].join('\t') + '\n');
    }

    // Add trailing slash to directories
    if (isDir) {
        path = path + '/';
        info.path = path;
        // HACK: fsevent is passing an unknown event for directory creation (deleted works)
        if (info.event === 'unknown') {
            // HACK: fsevent passes an unknown event for directory chowning
            if (info.changes.inode || info.changes.access || info.changes.xattrs || info.changes.finder) {
                console.warn('Ignoring chown/chmod to: ' + path);
                DEBUG && console.log(info);
                return;
            }
            info.event = 'created';
        }
    }

    dst = relPath;
    ignore = shouldIgnore('watch', relPath);

    switch (info.event) {
        case 'modified':
        case 'created':
            verb = isDir ? 'MKCOL' : 'PUT';
            src = path;
            break;
        case 'deleted':
            verb = 'DELETE';
            dst = null;
            break;
        case 'moved-in':
            if (movedOut) {
                src = getRelativePath(config.localDir, movedOut);
                dst = relPath;
                movedOut = null;
            }
            verb = 'MOVE';
            break;
        case 'moved-out':
            movedOut = path;
            break;
    }

    if (verb) {
        // Do not log ignored watch events if logIgnored is false
        if (ignore && config.logIgnored === false) {
            return;
        }

        if (verb === 'MKCOL' || verb === 'DELETE') {
            path = relPath;
            dst = path;
            src = null;
        }

        // File was ignored in either global or watch
        if (ignore) {
            console.log((ignore ? colors.yellow('[IGNORED] ') : '') + verb + ': ' + relPath + (dst ? ' -> ' + dst : ''));
            return;
        }

        // TODO: Memoize should ignore
        if (!shouldIgnore('sync', relPath)) {
            q.push({
                verb: verb, dst: dst, src: src, cb: function (err) {
                    if (err) {
                        playSound(config.sound.error);
                        console.log(colors.red('[FAILED ] ') + verb + ': ' + relPath + (dst ? ' -> ' + dst : '') + '(' + err + ')');
                        return;
                    }

                    drainSound = (drainSound === null) ? config.sound.success : drainSound;
                    console.log(colors.green('[SUCCESS] ') + verb + ': ' + relPath + (dst ? ' -> ' + dst : ''));
                }
            });
        }
    }

});

watcher.start();
