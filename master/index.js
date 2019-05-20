let APIStatus = require('./APIStatus/APIStatus').APIStatus;
let socketServerCreationAndConnection = require('./socketServerManagement/socketServerCreationAndConnection');
let socketServerWebClientManagement = require('./socketServerManagement/socketServerWebClientManagement');

let expressCreation = require('./expressManagement/expressCreation');
let expressEndpoint = require('./expressManagement/expressEndpoint');

let services = {};
services.socketSlaves = {};
services.webClients = [];

let app = expressCreation.createApp(APIStatus);
let httpServer = expressCreation.createHTTPServer(app);
expressEndpoint.createEndpoints(app);

let socketServer = socketServerCreationAndConnection.createSocketServer(httpServer);
services.socketServer = socketServer;
socketServerCreationAndConnection.createChannel(
	(webclient) => {
		services.webClients.push(webclient);
		socketServerWebClientManagement.createAPIStatusRequest(webclient);
		socketServerWebClientManagement.createAddingServerToTest(webclient);
	},
	(slaveName, socketClient) => {
		services.socketSlaves[slaveName] = socketClient;
	});

socketServerCreationAndConnection.createChannelForSlave((slave, socketClient) => {
	services.socketSlaves[slave.name] = socketClient;
});
expressCreation.launchHTTPServer(httpServer, 8080);