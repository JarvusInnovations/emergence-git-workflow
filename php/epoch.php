<?php

$error = null;
$epoch = null;

try {
    $epoch = \DB::allRecords('SELECT UNIX_TIMESTAMP(NOW()) AS epoch');
    $epoch = $epoch[0]['epoch'];
} catch(Exception $e) {
    $error = $e->getMessage();
}

header('Content-Type: application/json');

print json_encode([
    "success" => ($epoch !== null),
    "epoch" => $epoch,
    "error" => $error
]);
