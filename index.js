const {
  Worker,
  isMainThread,
  parentPort,
  threadId,
} = require('worker_threads');
const crypto = require('crypto');

const { createSupervisor } = require('./supervisor');

const masterSupervisor = isMainThread ? createSupervisor() : null;

const isFromWorker = (payload) => Boolean(payload.fromWorker);

const createFingerprint = () => crypto.randomBytes(64).toString('hex');

const createWorkerContent = (job, sharedVarNames) => {
  let sharedVarsCode = '';
  const currentFileNameAsString =  JSON.stringify(__filename);
  if(sharedVarNames.length > 0) {
    sharedVarsCode = `
      let {${sharedVarNames.join(",")}} = require('worker_threads').workerData;
    `;
  }
  return `
    ${sharedVarsCode}
    (${job.toString()})(require(${currentFileNameAsString}));
  `;
}

const spawn = (job, name, vars = {}) => {
  return new Promise((resolve) => {
    const workerContent = createWorkerContent(job, Object.keys(vars));
    const actor = new Worker(workerContent, { eval: true, workerData: vars });
    actor.on('message', (payload) => {
      if (isFromWorker(payload)) {
        const { recipient } = payload;
        masterSupervisor.send(recipient, payload);
      }
    });
    masterSupervisor.store(name, actor);
    resolve(actor);
  });
};

const receive = (reducer, startState = undefined) => {
  let state = startState;
  parentPort.on('message', (message) => {
    state = reducer(state, message);
  });
};

const send = (recipient, content) => {
  if (isMainThread) {
    masterSupervisor.send(recipient, { content });
  } else {
    parentPort.postMessage({ fromWorker: true, recipient, content });
  }
};

const reply = (request, response) => {
  const { fingerprint: requestFingerprint, sender: requestSender } = request;
  const message = {
    requestSender,
    content: response,
    recipient: requestSender,
    fingerprint: requestFingerprint,
    sender: threadId,
    fromWorker: !isMainThread,
  };

  if (isMainThread) {
    masterSupervisor.send(message);
  } else {
    parentPort.postMessage(message);
  }
};

const call = (recipient, messageContent) => {
  return new Promise((resolve) => {
    const fingerprint = createFingerprint();

    const message = {
      recipient,
      fingerprint,
      content: messageContent,
      sender: threadId,
      fromWorker: !isMainThread,
    };

    if (isMainThread) {
      const actor = masterSupervisor.getProcess(recipient);
      const callback = (payload) => {
        if (payload.fingerprint === fingerprint) {
          resolve(payload);
          actor.off('message', callback);
        }
      };
      actor.on('message', callback);
      masterSupervisor.send(recipient, message);
    } else {
      const callback = (payload) => {
        if (payload.fingerprint === fingerprint) {
          resolve(payload);
          parentPort.off('message', callback);
        }
      };
      parentPort.on('message', callback);
      parentPort.postMessage(message);
    }
  });
};

const shutdown = (supervisor = masterSupervisor) => {
  supervisor.shutdown();
};

module.exports = {
  spawn,
  receive,
  send,
  call,
  reply,
  shutdown,
  createSupervisor,
  masterSupervisor,
};
