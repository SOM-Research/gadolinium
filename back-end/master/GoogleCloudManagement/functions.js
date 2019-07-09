let path = require('path');
let regionList = require('./regionList');

let getGoogleAuth = async () => {
	const {auth} = require('google-auth-library');
	const client = await auth.getClient({
		scopes: [
			'https://www.googleapis.com/auth/cloud-platform',
			'https://www.googleapis.com/auth/compute',
			'https://www.googleapis.com/auth/compute.readonly',
		],
		keyFilename: path.join(__dirname, 'GCPKeyFile.json')
	});
	return {auth, client};
};

// createVM(zone, name, sourceInstanceTemplate)
// 	.then(console.log)
// 	.catch(console.error);

const createVM = async (zone, vmName) => {
	let {auth, client} = await getGoogleAuth();
	const templateName = `gadolinium-template`;
	const projectId = await auth.getProjectId();

	const sourceInstanceTemplate = `projects/${projectId}/global/instanceTemplates/${templateName}`;
	const url = `https://www.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances?sourceInstanceTemplate=${sourceInstanceTemplate}`;

	console.log(`Attempt to create a Google Cloud Platform instance named ${templateName}`);
	return await client.request({
		url: url,
		method: 'post',
		data: {name: vmName}
	});
};

const deleteVM = async (zone, vmName) => {
	let {auth, client} = await getGoogleAuth();
	const projectId = await auth.getProjectId();
	console.log('Deletion of ' + vmName + ' instance on Google Cloud Platform');

	const url = `https://www.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances/${vmName}`;

	try {
		return await client.request({
			url: url,
			method: 'delete',
			data: {name: vmName}
		});
	} catch (e) {
		return {
			status: e.code,
			errors: e.errors
		};
	}
};

const turnVM = async (on, zone, vmName) => {
	let {auth, client} = await getGoogleAuth();
	const projectId = await auth.getProjectId();

	console.log(`Attempt to turn ${on ? 'On' : 'Off'} the ${vmName} instance from Google Cloud Platform`);

	const url = `https://www.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances/${vmName}/${on ? 'start' : 'stop'}`;
	try {
		return await client.request({
			url: url,
			method: 'post'
		});
	} catch (e) {
		return {
			status: e.code,
			errors: e.errors
		};
	}

};

const setBootUpScript = async (zone, vmName) => {
	let {auth, client} = await getGoogleAuth();
	const projectId = await auth.getProjectId();
	let url = `https://www.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances/${vmName}/setMetadata`;
	let object = {
		"items": [
			{
				"key": "startup-script",
				"value": "#!/usr/bin/env bash\n" +
					"cd gadolinium/back-end/slave\n" +
					"INSTANCENAME=$(./gcp-metadata/gcp-metadata -n | cut -d ':' -f 2 | cut -d ' ' -f 2)\n" +
					"node index.js \"$INSTANCENAME\"\n"
			}
		]
	};
	try {
		return await client.request({
			url: url,
			method: 'post',
			date: object
		});
	} catch (e) {
		return {
			status: e.code,
			errors: e.errors
		};
	}
}

function getListOfZones() {
	return regionList;
}

module.exports = {
	createVM: createVM,
	deleteVM: deleteVM,
	turnVM: turnVM,
	getListOfZones: getListOfZones,
	setBootUpScript: setBootUpScript
};
