
"use strict";

var angular = require ('angular');

var EventEmitter = require ('events').EventEmitter;

var settings = require ('settings');
require ('debug').enable (settings.debug);
var debug = require ('debug')('wyliodrin:lacy:wydevice');

var compare_versions = require ('compare-versions');

var uuid = require ('uuid');
var _ = require ('lodash');
var moment = require ('moment');

var WyliodrinDevice = require ('./WyliodrinDevice.js');

var TIMEOUT = 10;

debug ('Loading');

var app = angular.module ('wyliodrinApp');

app.factory ('$wydevices', function ($http)
{
	debug ('Registering');

	var LocalDevices = null;
	
	var devicesTree = {};
	var devicesList = [];

	function updateDevices (mdnsDevices, uplink)
	{
		var device; 
		for (var m=0; m<mdnsDevices.length; m++)
    	{
    		device = mdnsDevices[m];

    		if (devicesTree[device.id])
    		{
    			var existingDevice = devicesTree[device.id];
    			existingDevice._mdns = true;
    		}
    		else
    		{
    			device.name = (device.name?device.name:'');
    			device.port = (device.port?device.port:7000);
    			device.secureport = (device.secureport?device.secureport:22);
    			
    			device.connection.status = 'DISCONNECTED';

    			device.properties.category = (device.category?device.category:'board');
    			device.properties.platform = (device.platform?device.platform:'linux');

    			device._mdns = true;
    			devicesTree[device.id] = device;
    			devicesList.push (device);
    		}
    	}

    	var i=0;
    	while (i<devicesList.length)
    	{
    		device = devicesList[i];
    		if (!device._mdns && device.uplink === uplink)
    		{
    			if (device.connection.status === 'DISCONNECTED' || 
    				device.connection.status === 'ERROR')
    			{
    				device.connection.status = 'MISSING';
    				device._timeout = moment ().add (TIMEOUT, 'minutes');
    				i++;
    			}
    			else if (device.connection.status === 'MISSING' && 
    				moment(device._timeout).isBefore ())
    			{
    				delete devicesTree[device.id];
    				devicesList.splice (i,1);
    			}
    		}
    		else
    			i++;
    	}
	}
	
	if (settings.platform.CHROME)
	{
		chrome.runtime.getBackgroundPage(function (backgroundPage) {
		    LocalDevices = backgroundPage.LocalDevices;
		    LocalDevices.registerSerialListener (function (serialDevices)
		    {
		    	// devices.serial = serialDevices;
		    	// console.log (devices);

		    	updateDevices (serialDevices, 'serial');
		    	devicesService.emit ('devices', devicesList, devicesTree);

		    });
		    LocalDevices.registerLocalListener (function (localDevices)
		    {
		    	// devices.local = localDevices;
		    	// console.log (devices);
		    	updateDevices (localDevices, 'local');
		    	devicesService.emit ('devices', devicesList, devicesTree);
		    });
		});
	}

	var devicesService = {
		getDevices: function ()
		{
			devicesService.emit ('devices', devicesList, devicesTree);
		},
		// options={
		//  ip:
		// 	name
		//	username:
		//	password:
		//	port:
		//	secureport:
		//	type: chrome-socket/chrome-ssh
		// }
		connect: function (uplink, deviceId, options)
		{
			if (!WyliodrinDevice) throw ('Wyliodrin device not initialised');		

			debug (options);

			var device;
			var newDevice = false;

			if (deviceId)
				device = devicesTree[deviceId];
			else if (options.ip)
			{
				device = _.find (devicesList, function (device){
					return device.ip === options.ip;
				});
				if (device === undefined)
				{
					device = {
						id: options.ip,
						uplink: uplink,
						status: 'DISCONNECTED'
					};

					devicesList.push (device);
					devicesTree[device.id] = device;
					newDevice = true;
				}
			}

			device.name = (options.name?options.name:device.name);
			device.ip = (options.ip?options.ip:device.ip);
			device.port = (options.port?options.port:device.port);
			device.secureport = (options.secureport?options.secureport:device.secureport);
			device.username = (options.username?options.username:device.username);

			device._WyliodrinDevice = new WyliodrinDevice (options);

			devicesService.emit ('devices', devicesList, devicesTree);

			var that = this;
			
			device._WyliodrinDevice.on ('connection_login_failed', function ()
			{
				that.emit ('connection_login_failed:'+device.uplink+':'+device.id, device);
			});

			device._WyliodrinDevice.on ('connection_error', function ()
			{
				that.emit ('connection_error:'+device.uplink+':'+device.id, device);
			});

			device._WyliodrinDevice.on ('connection_timeout', function ()
			{
				that.emit ('connection_timeout:'+device.uplink+':'+device.id, device);
			});
			
			device._WyliodrinDevice.on ('status', function (_status)
			{
				device.status = _status;
				
				if (_status === 'ERROR' || _status === 'DISCONNECTED')
				{
					device.removeAllListeners ();
					delete device._WyliodrinDevice;	
				}
				that.emit ('status:'+device.uplink+':'+device.id, device);
			});

			device._WyliodrinDevice.on ('message', function (t, d)
			{
				if (t === 'i')
				{
					// console.log (d);
					device.name = d.n;
					device.properties = 
					{
						category: (d.c?d.c:device.properties.category),
						device: (d.device?d.device:''),
						platform: (d.platform?d.platform:device.properties.platform),
						osname: (d.osname?d.osname:''),
						osver: (d.osver?d.osver:''),
						version: (d.version?d.version:''),
						libwyliodrin: (d.libwyliodrin?d.libwyliodrin:''),
						wyliodrin_server: (d.wyliodrin_server?d.wyliodrin_server:'')
					};
					device.peripherals = d.peripherals;
					that.emit ('device_info', device);
				}
				else
				if (t === 'capabilities')
				{
					debug (d);
					device.properties.capabilities = d;
					that.emit ('device_info', device);
				}
				else
				if ((t === 'v' || t === 'sv') && !d.s)
				{
					device.properties.version = d.v;
					
					$http.get('https://cdn.rawgit.com/Wyliodrin/wyliodrin-app-server/master/package.json?'+uuid.v4())
				       .then(function(res){
					       	try
					       	{
					        	var version = res.data.version;
					        	debug ('Version '+version);
					        	debug (compare_versions(d.v, version));
					        	if (compare_versions(d.v, version) < 0) 
					        		that.emit ('update:'+device.uplink+':'+device.id);
					        }
					        catch (e)
					        {
					        	debug ('Version error');
					        	debug (e);
					        }
				    	});
				}				
				that.emit ('message:'+device.uplink+':'+device.id, t, d, deviceId);
			});
		},
		send: function (tag, data, device)
		{
			device._WyliodrinDevice.send (tag, data);
		},

		disconnect: function (device)
		{
			// console.log (device);
			device._WyliodrinDevice.disconnect ();
		}
		// setStatus: function (deviceId, status)
		// {
		// 	_.forEach (devices, function (deviceList){
		// 		for (var i=0; i<deviceList.length; i++)
		// 		{
		// 			if (deviceList[i].id === deviceId)
		// 				deviceList[i].status = status;
		// 		}
		// 	});
		// }
	};

	devicesService = _.assign (new EventEmitter(), devicesService);

	return devicesService;
});
