const { TsdkRuntime } = require('./tsdk-runtime');

let defaultRuntime = null;

function setRuntime(runtime) {
    if (runtime != null && !(runtime instanceof TsdkRuntime)) {
        throw new TypeError('crypto-wasm runtime must be a TsdkRuntime');
    }
    defaultRuntime = runtime;
}

function getRuntime() {
    if (!defaultRuntime) throw new Error('TSDK runtime has not been configured');
    return defaultRuntime;
}

async function initWasm() {
    return getRuntime().init();
}

async function generateToken(value) {
    await initWasm();
    return getRuntime().generateToken(value);
}

async function encryptBuffer(buffer) {
    await initWasm();
    return getRuntime().encrypt(buffer);
}

async function decryptBuffer(buffer) {
    await initWasm();
    return getRuntime().decrypt(buffer);
}

async function bindUser(openId) {
    await initWasm();
    getRuntime().bindUser(openId);
}

function getEncryptedInitInfo() {
    return getRuntime().getEncryptedInitInfo();
}

function getDataToServer() {
    return getRuntime().getDataToServer();
}

function sendDataFromServer(data) {
    getRuntime().sendDataFromServer(data);
}

function heartbeatTick() {
    getRuntime().heartbeatTick();
}

function processReceivedData() {
    getRuntime().processReceivedData();
}

function sendStatus() {
    getRuntime().sendStatus();
}

function detectSpeedHack(elapsedMs) {
    getRuntime().detectSpeedHack(elapsedMs);
}

function destroyWasm() {
    if (defaultRuntime) {
        defaultRuntime.destroy();
        defaultRuntime = null;
    }
}

module.exports = {
    setRuntime,
    getRuntime,
    initWasm,
    generateToken,
    encryptBuffer,
    decryptBuffer,
    encryptData: generateToken,
    bindUser,
    getEncryptedInitInfo,
    getDataToServer,
    sendDataFromServer,
    heartbeatTick,
    processReceivedData,
    sendStatus,
    detectSpeedHack,
    destroyWasm,
};
