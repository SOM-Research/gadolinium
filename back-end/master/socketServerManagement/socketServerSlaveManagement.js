let {DateTime, Duration} = require("luxon");

let colors = require('colors');
let APIStatusFunc = require('../APIStatus/functions');
let socketServerFunc = require('./socketServerCreationAndConnection');
let GCPFunc = require('../GoogleCloudManagement/functions');

//Variables initialized in case master crashes and has to restart
let slavesCreating = new Map();
let slavesTesting = new Map();
let slavesCompleted = new Map();
let slavesDisconnected = new Map();
let slaveHandledSlaves = new Map();
let masterHandledSlaves = new Map();
let slavesWaiting = new Map();
let slavesRecording = new Map();
let slavesBooting = new Map();
let latencySlaves = new Map();
let uptimeSlaves = new Map();
let slavesToDelete = new Map();

let updateMapsWithAPIStatus = () => {
	let APIStatus = APIStatusFunc.getAPIStatus();
	APIStatus.map((api) => {
		let servers = api.servers;
		servers.map((server) => {
			switch (server.executionType) {
				case 'masterHandled':
					masterHandledSlaves.set(server.name, api.id);
					break;
				case 'slaveHandled' :
					slaveHandledSlaves.set(server.name, api.id);
					break;
			}
			switch (server.testType) {
				case 'latency' :
					latencySlaves.set(server.name, api.id);
					break;
				case 'uptime':
					uptimeSlaves.set(server.name, api.id);
					break;
			}
			switch (server.state) {
				case 'creating':
					slavesCreating.set(server.name, api.id);
					break;
				case 'testing':
					slavesTesting.set(server.name, api.id);
					if (slaveHandledSlaves.has(server.name)) {
						slavesRecording.set(server.name, api.id);
					} else if (masterHandledSlaves.has(server.name)) {
						switch (server.substate) {
							case 'waiting':
								slavesWaiting.set(server.name, api.id);
								restartTimerToRebootVM(api.id, server.name);
								break;
							case 'booting' :
								slavesBooting.set(server.name, api.id);
								break;
							case 'recording':
								slavesRecording.set(server.name, api.id);
						}
					}
					break;
				case 'completed' :
					slavesCompleted.set(server.name, api.id);
					slavesToDelete.set(server.name, api.id);
					break;
			}
			slavesDisconnected.set(server.name, api.id);
		})
	})
};

let addSlaveToMaps = (apiId, slaveName) => {

};

let getFirstDateTimeRecordFromAServer = (apiId, server) => {
	let api = APIStatusFunc.getAPI(apiId);
	if (server.testType === 'latency') {
		return DateTime.min(...api.httpRequests.reduce((accum, httpRequest) => {
			return [accum, ...Object.values(httpRequest.testResults).reduce((accum, results) => {
				return [accum, ...results.latencyRecords.map(record => DateTime.fromISO(record.date))]
			}, [])];
		}, []))
	} else if (server.testType === 'uptime') {
		return DateTime.min(...api.uptimeResults[server.name].reduce((accum, serverRecord) => {
			return [accum, ...serverRecord.map(record => DateTime.fromISO(record.date))];
		}, []));
	}
};

let getNumberOfRepetitionsDone = (apiId, server) => {
	let api = APIStatusFunc.getAPI(apiId);
	return api.testConfig[server.testType].repetitions - server.repetitionsRemaining;
};

let getIntervalBetweenRepetitions = (apiId, server) => {
	let api = APIStatusFunc.getAPI(apiId);
	return Duration.fromISO(api.testConfig[server.testType].interval.iso8601format);
};

let restartTimerToRebootVM = (apiId, slaveName) => {
	console.log(`${slaveName.bold.underline} : Restart timer lost`);
	let server = APIStatusFunc.getServer(apiId, slaveName);
	let firstDateTimeRecord = getFirstDateTimeRecordFromAServer(apiId, server);
	let nbRepetitionDone = getNumberOfRepetitionsDone(apiId, server);
	let intervalBetweenRepetitions = getIntervalBetweenRepetitions(apiId, server);
	let nextDateTimeRecord = firstDateTimeRecord.plus(Duration.fromMillis(nbRepetitionDone * intervalBetweenRepetitions.valueOf()));
	let millisecondsIntervalUntilNextRepetition = nextDateTimeRecord.diff(Duration.fromMillis(new DateTime(Date.now()).toMillis())).valueOf();
	if (millisecondsIntervalUntilNextRepetition > 0) {
		GCPFunc.setBootUpScript(server.zone, slaveName);
		setTimeout(() => {
			slavesWaiting.delete(slaveName);
			slavesBooting.set(slaveName, apiId);
			APIStatusFunc.applyFunctionToOneServer(apiId, slaveName, server => server.substate = 'booting');
			GCPFunc.turnVM(true, server.zone, slaveName);
		}, millisecondsIntervalUntilNextRepetition);
		console.log(`${slaveName.bold.underline} : Restarting in ${millisecondsIntervalUntilNextRepetition / 60000} minutes`);
	} else {
		APIStatusFunc.applyFunctionToOneServer(apiId, slaveName, (server) => server.status = "Test failed, please delete this configuration and create a new one.")
	}

};

let getTestTypeOfSlave = (slaveName) => {
	return latencySlaves.has(slaveName) ? 'latency' : uptimeSlaves.has(slaveName) ? 'uptime' : ''
};

let getExecutionTypeOfSlave = (slaveName) => {
	return masterHandledSlaves.has(slaveName) ? 'master' : slaveHandledSlaves.has(slaveName) ? 'slave' : '';
};

let slaveConnectedForTheFirstTime = (slaveClient, slaveName) => {
	console.log(`${slaveName.bold.underline} : Connected for the first time`);

	let api = APIStatusFunc.getAPI(slavesCreating.get(slaveName));
	let testType = getTestTypeOfSlave(slaveName);
	let executionType = getExecutionTypeOfSlave(slaveName);
	APIStatusFunc.initializeServerState(api.id, slaveName, testType, `${executionType}Handled`);
	slavesCreating.delete(slaveName);
	slavesTesting.set(slaveName, api.id);
	slavesRecording.set(slaveName, api.id);
	APIStatusFunc.applyFunctionToOneServer(api.id, slaveName, (server) => {
		server.state = 'testing';
		server.substate = 'recording'
	});
	slaveClient.emit(`${executionType}HandledTest`, {api: api, testType: testType});
};

let slaveHandledSlaveReconnected = (slaveClient, slaveName) => {
	console.log(`${slaveName.bold.underline} : Slave handled slave reconnected`);
	console.log(`Cached records may be received`);
	slaveClient.emit('reconnection');
	slavesDisconnected.delete(slaveName);
};

let masterHandledSlaveReconnected = (slaveClient, slaveName) => {
	console.log(`${slaveName.bold.underline} : Master handled slave reconnected`);
	let api = APIStatusFunc.getAPI(masterHandledSlaves.get(slaveName));
	let testType = getTestTypeOfSlave(slaveName);
	slavesDisconnected.delete(slaveName);
	slavesBooting.delete(slaveName);
	slavesWaiting.delete(slaveName);
	slavesRecording.set(slaveName, api.id);
	APIStatusFunc.applyFunctionToOneServer(api.id, slaveName, (server) => server.substate = 'recording');
	slaveClient.emit('masterHandledTest', {api: api, testType: testType})
};

let slaveConnected = (slaveClient, slaveName) => {
	if (slavesToDelete.has(slaveName)) {
		//The slave need to be deleted for a certain reason
		slaveClient.disconnect();
	} else if (slavesDisconnected.has(slaveName)) {
		//The slave was disconnected
		if (slavesCompleted.has(slaveName)) {
			//The slave has completed all test he was supposed to do
			slaveClient.disconnect();
		} else if (slavesCreating.has(slaveName)) {
			//The slave was being created by the service provider and the VM just connected for the first time
			slaveConnectedForTheFirstTime(slaveClient, slaveName);
		} else if (slavesTesting.has(slaveName)) {
			//The slave is currently testing an API
			if (slaveHandledSlaves.has(slaveName)) {
				slaveHandledSlaveReconnected(slaveClient, slaveName);
			} else if (masterHandledSlaves.has(slaveName)) {
				if (slavesBooting.has(slaveName)) {
					masterHandledSlaveReconnected(slaveClient, slaveName);
				} else {
					console.log(`${slaveName.bold.underline} : Not booting`.red);
				}
			} else {
				console.log(`${slaveName.bold.underline} : Execution type not handled`.red);
			}
		} else {
			console.log(`${slaveName.bold.underline} : Not in creating or testing maps`.red);
		}
	} else {
		console.log(`${slaveName.bold.underline} : Not disconnected`);
	}
	socketServerFunc.emitAPIStatusUpdate();
};

let deleteSlave = (slaveName) => {
	let apiId = slavesToDelete.get(slaveName);
	let server = APIStatusFunc.getServer(apiId, slaveName);
	GCPFunc.deleteVM(server.zone, slaveName);
	slavesToDelete.delete(slaveName);
};

let slaveDisconnected = (slaveClient, slaveName, slaveCallback) => {
	slaveClient.on('disconnect', () => {
		console.log(`${slaveName.bold.underline} : Disconnected`);
		let reason;
		if (slavesToDelete.has(slaveName)) {
			console.log(`${slaveName.bold.underline} : Needs to be deleted`);
			deleteSlave(slaveName);
			reason = "vmDeleted";
			slavesDisconnected.delete(slaveName);
		} else if (slavesTesting.has(slaveName)) {
			reason = "unwantedDisconnection";
			APIStatusFunc.applyFunctionToOneServer(slavesTesting.get(slaveName), slaveName, server => server.status = 'Disconnected. Trying to reconnected...');
			slavesDisconnected.set(slaveName, slavesTesting.get(slaveName));
		} else if (slavesCompleted.has(slaveName)) {
			console.log(`${slaveName.bold.underline} : Completed all tests and needs to be deleted`);
			deleteSlave(slaveName);
			reason = "vmDeleted";
			slavesCompleted.delete(slaveName);
		}
		socketServerFunc.emitAPIStatusUpdate();
		slaveCallback(reason);
	});
	slaveClient.on('consoleMessage', data => console.log(data.green));
};

let saveTheRecord = (slaveName, record) => {
	if (latencySlaves.has(slaveName)) {
		APIStatusFunc.updateOperationTestResults(record.apiId, slaveName, record.httpRequestIndex, record.testResults);
	} else if (uptimeSlaves.has(slaveName)) {
		APIStatusFunc.recordAPIUpTime(record.apiId, slaveName, record.up, record.date);
	} else {
		console.log(`${slaveName.bold.underline} : Neither a latency nor an uptime slave`);
	}
};

let emitTheRecordToWebClients = (slaveName, record) => {
	if (latencySlaves.has(slaveName)) {
		socketServerFunc.emitLatencyTestUpdate(
			record.apiId,
			slaveName,
			record.httpRequestIndex,
			record.testResults.latencyRecords[0]);
	} else if (uptimeSlaves.has(slaveName)) {
		socketServerFunc.emitUptimeTestUpdate(
			record.apiId,
			slaveName,
			record.up,
			record.date);
	}
};

let rebootTheVM = (apiId, slaveName) => {
	let server = APIStatusFunc.getServer(apiId, slaveName);
	let millisecondsIntervalUntilNextRepetition;
	if (latencySlaves.has(slaveName)) {
		millisecondsIntervalUntilNextRepetition = APIStatusFunc.getLatencyInterval(apiId);
	} else if (uptimeSlaves.has(slaveName)) {
		millisecondsIntervalUntilNextRepetition = APIStatusFunc.getUptimeInterval(apiId);
	}
	GCPFunc.turnVM(false, server.zone, server.name);
	GCPFunc.setBootUpScript(server.zone, slaveName);
	setTimeout(() => {
		slavesWaiting.delete(slaveName);
		slavesBooting.set(slaveName, apiId);
		APIStatusFunc.applyFunctionToOneServer(apiId, slaveName, server => server.substate = 'booting');
		GCPFunc.turnVM(true, server.zone, slaveName);
	}, millisecondsIntervalUntilNextRepetition);
	console.log(`${slaveName.bold.underline} : Restarting in ${millisecondsIntervalUntilNextRepetition / 60000} minutes`);

};

let repetitionFinishedFor = (slaveClient, slaveName, apiId) => {
	if (APIStatusFunc.isLastTest(apiId, slaveName)) {
		console.log(`${slaveName.bold.underline} : It was last repetition.`);
		APIStatusFunc.applyFunctionToOneServer(apiId, slaveName, server => {
			server.status = "Test completed.";
			server.repetitionsRemaining = 0;
		});
		slavesToDelete.set(slaveName, apiId);
		slavesCompleted.set(slaveName, apiId);
		APIStatusFunc.applyFunctionToOneServer(apiId, slaveName, server => server.state = 'completed');
		slaveClient.disconnect();
	} else {
		APIStatusFunc.applyFunctionToOneServer(apiId, slaveName, server => {
			server.repetitionsRemaining--;
			console.log(`${slaveName.bold.underline} : ${server.repetitionsRemaining} tests remaining`);
		});
		if (masterHandledSlaves.has(slaveName)) rebootTheVM(apiId, slaveName);

	}
};

let slaveTesting = (slaveClient, slaveName) => {
	slaveClient.on('record', (record) => {
		if (slavesTesting.has(slaveName)) {
			if (slavesRecording.has(slaveName)) {
				saveTheRecord(slaveName, record);
				APIStatusFunc.applyFunctionToOneServer(record.apiId, slaveName, (server) => {
					server.progress++;
					console.log(`${slaveName.bold.underline} : Record ${server.progress} / ${server.totalProgress}`);
				});
				emitTheRecordToWebClients(slaveName, record);
			} else {
				console.log(`${slaveName.bold.underline} : Not recording`.red);
			}
		} else {
			console.log(`${slaveName.bold.underline} : Not testing`.red);
		}
	});

	slaveClient.on('repetition', ({apiId}) => {
		if (slavesTesting.has(slaveName)) {
			if (slavesRecording.has(slaveName)) {
				repetitionFinishedFor(slaveClient, slaveName, apiId);
				if (masterHandledSlaves.has(slaveName)) {
					slavesRecording.delete(slaveName);
					slavesWaiting.set(slaveName, apiId);
					APIStatusFunc.applyFunctionToOneServer(apiId, slaveName, server => server.substate = 'waiting');
				}
			} else {
				console.log(`${slaveName.bold.underline} : Not recording`.red);
			}
		} else {
			console.log(`${slaveName.bold.underline} : Not testing`.red);
		}
	});
};

module.exports = {
	slaveConnected: slaveConnected,
	updateMapsWithAPIStatus: updateMapsWithAPIStatus,
	slaveDisconnected: slaveDisconnected,
	slaveTesting: slaveTesting,
	addSlaveToMaps: addSlaveToMaps
};
