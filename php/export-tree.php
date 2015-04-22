<?php

namespace Emergence;

use Emergence\People\User;

// Authenticate a developer using HTTP auth (easier to use from the shell)
function basicAuth() {
    $authEngine = new \Sabre\HTTP\BasicAuth();
    $authEngine->setRealm('Develop ' . \Site::$title);
    $authUserPass = $authEngine->getUserPass();

    $userClass = User::$defaultClass;
    $User = $userClass::getByLogin($authUserPass[0], $authUserPass[1]);

    if (!$User || !$User->hasAccountLevel('Developer')) {
        $authEngine->requireLogin();
        die("Authentication required\n");
    }
}

// Emergence lazy loads inherited files, this will retrieve all of those files explicitly, minus Sencha files
function retrieveRemoteFiles() {
    $collectionRecords = \DB::allRecords('
      SELECT DISTINCT(handle)
        FROM _e_file_collections
       WHERE ParentID IS NULL
         AND handle NOT LIKE "sencha-%%"
         AND site="Remote"
     ');

    $cacheCollections = ['sencha-workspace/pages', 'sencha-workspace/packages'];

    foreach ($collectionRecords as $record) {
        $cacheCollections[] = $record['handle'];
    }

    foreach ($cacheCollections as $collection) {
        \Emergence_FS::cacheTree($collection, true);
    }
}

// This exports the VFS to a directory, which represents the entire site and all inherited files
function exportTree($exportDir) {
    $topLevelDirectories = \DB::allRecords('SELECT DISTINCT(handle) FROM _e_file_collections WHERE ParentID IS NULL AND handle NOT LIKE "sencha-%%"');
    $topLevelDirectories = array_merge($topLevelDirectories, [
        ['handle' => 'sencha-workspace/pages'],
        ['handle' => 'sencha-workspace/packages']
    ]);

    foreach ($topLevelDirectories as $collection) {
        $handle = $collection['handle'];

        $destDir = $exportDir . '/' . $handle;
        \Emergence_FS::exportTree($handle, $destDir, ['dataPath' => false]);
    }
}

// Generates a file containing the SHA1 checksum of the files in a given directory, one per-line, example:
// 0012f763662dfce403e0193152a0ff1aeae7d681  php-classes/Slate/CBL/DemonstrationSkill.php
function generateChecksumFile($dir, $filename) {
    shell_exec("cd $dir && find . -not -path '*/.emergence/*' -not -path '*/.git/*' -not -iname '.*' ! -iname 'mark' -type f -print | xargs sha1sum | sed 's/\.\///' | sort > $filename");
}

// Serves a gzipped tarball (.tar.gz) of the given directory, suitable for piping from wget or curl directly to tar
function outputTarball($exportDir) {
    ob_end_clean();
    header('Content-Type: application/x-gzip');

    chdir($exportDir);

    $fp = popen("tar -cvzf - .", "r");

    while (!feof($fp)) {
        echo fread($fp, 8192);
    }

    pclose($fp);
}

\Site::$autoPull = true;
\Site::$debug = true;
set_time_limit(0);

$exportDir = isset($_GET['dir']) ? $_GET['dir'] : ('/tmp/' . \Site::$title);
$outputTar = isset($_GET['tar']) ? $_GET['tar'] == '0' : false;

basicAuth();
retrieveRemoteFiles();
exportTree($exportDir);
generateChecksumFile($exportDir, '.vfs_checksums');
$checksumFile = file_get_contents($exportDir . "/.vfs_checksums");

if ($outputTar) {
    header("Content-type: application/octet-stream");
    header("Content-disposition: attachment;filename=.vfs_checksums");
    print $checksumFile;
} else {
    outputTarball($exportDir);
}
