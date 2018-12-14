'use strict';

const Homey = require('homey'),
    {HomeyAPI} = require('athom-api'),
    _ = require('lodash');

const modeNames = {
    "Comfort": "Comfort",
    "ECO": "Energy Saving",
    "Off": "Off",
    "Cooling": "Cooling"
};

class VThermoDevice extends Homey.Device {

    onInit() {
        this.log('virtual device initialized');

        this.log('name:', this.getName());
        this.log('class:', this.getClass());
        this.log('data:', this.getData());
        this.log('id:', this.getData().id);

        this._modeChangedTrigger = new Homey.FlowCardTriggerDevice('vt_mode_changed');
        this._modeChangedTrigger
            .register();

        this._modeChangedToTrigger = new Homey.FlowCardTriggerDevice('vt_mode_changed_to');
        this._modeChangedToTrigger
            .register()
            .registerRunListener((args, state) => args.vt_mode === state.vt_mode);

        this._turnedOnTrigger = new Homey.FlowCardTriggerDevice('vt_onoff_true');
        this._turnedOnTrigger
            .register();

        this._turnedOffTrigger = new Homey.FlowCardTriggerDevice('vt_onoff_false');
        this._turnedOffTrigger
            .register();

        this._onoffCondition = new Homey.FlowCardCondition('vt_onoff_is_on')
            .register()
            .registerRunListener((args, state) => args.device.getCapabilityValue('vt_onoff'));

        this._modeIsCondition = new Homey.FlowCardCondition('vt_mode_is')
            .register()
            .registerRunListener((args, state) => args.vt_mode === args.device.getCapabilityValue('vt_mode'));

        this._changeModeAction = new Homey.FlowCardAction('vt_change_mode')
            .register()
            .registerRunListener((args, state) => {
                args.device.setCapabilityValue('vt_mode', args.vt_mode);
                return this.updateVtMode(args.vt_mode);
            });

        this._changeModeSetpointAction = new Homey.FlowCardAction('vt_change_mode_setpoint')
            .register()
            .registerRunListener((args, state) => {
                this.updateSettings(args.vt_mode, args.setpointValue);
                if (args.vt_mode === args.device.getCapabilityValue('vt_mode')) {
                    args.device.setCapabilityValue('target_temperature', args.setpointValue);
                    return this.checkTemp({target_temperature: args.setpointValue});
                }
                return Promise.resolve();
            });

        this.registerCapabilityListener('target_temperature', (value, opts) => {
            let vtMode = this.getCapabilityValue('vt_mode');
            this.updateSettings(vtMode, value);
            return this.checkTemp({target_temperature: value});
        });

        this.registerCapabilityListener('vt_mode', (value, opts) => {
            this._modeChangedTrigger.trigger(this, {
                mode: value,
                modeName: modeNames[value]
            }, null).catch(console.error);
            this._modeChangedToTrigger.trigger(this, null, {
                vt_mode: value
            }).catch(console.error);
            return this.updateVtMode(value);
        });

        this.checkTemp();
    }

    onAdded() {
        this.log('virtual device added:', this.getData().id);
    }

    onSettings(oldSettings, newSettings, changedKeys, callback) {
        // TODO check temp if setpoint changed for current mode
        this.log('onSettings', oldSettings, newSettings, changedKeys);
    }

    onDeleted() {
        this.log('virtual device deleted');
    }

    async updateSettings(vtMode, setpointValue) {
        if (vtMode === 'Comfort') {
            this.setSettings({Comfort_setpoint: setpointValue});
        } else if (vtMode === 'ECO') {
            this.setSettings({ECO_setpoint: setpointValue});
        } else if (vtMode === 'Cooling') {
            this.setSettings({Cooling_setpoint: setpointValue});
        }
    }

    async updateVtMode(vtMode) {
        let setpointValue = this.getSetting(`${vtMode}_setpoint`);
        if (setpointValue) {
            this.setCapabilityValue('target_temperature', setpointValue);
        } else {
            setpointValue = this.getCapabilityValue('target_temperature');
        }

        return this.checkTemp({target_temperature: setpointValue, vt_mode: vtMode});
    }

    clearCheckTime() {
        if (this.curTimeout) {
            clearTimeout(this.curTimeout);
            this.curTimeout = undefined;
        }
    }

    scheduleCheckTemp(seconds) {
        this.clearCheckTime();
        this.log(`Checking temp in ${seconds} seconds`);
        this.curTimeout = setTimeout(this.checkTemp.bind(this), seconds * 1000);
    }

    async checkTemp(opts) {
        this.clearCheckTime();

        let currentHomey = await HomeyAPI.forCurrentHomey();
        let devices = await currentHomey.devices.getDevices();
        let zones = await currentHomey.zones.getZones();

        let settings = this.getSettings();
        let hysteresis = settings.hysteresis || 0.5;
        let zoneName = settings.zoneName;
        if (!zoneName) {
            this.log('no zoneName defined');
            this.scheduleCheckTemp(60);
            return Promise.resolve();
        }

        let zoneForThermostat = this.findZone(this.getData().id, zoneName, devices, zones);

        let thermometer = this.findThermometer(zoneName, devices);
        if (!thermometer) {
            this.scheduleCheckTemp(60);
            return Promise.resolve();
        }

        let vtMode = this.findVtMode(opts);

        let targetTemp = this.findTargetTemperature(opts, vtMode);
        if (!targetTemp) {
            this.scheduleCheckTemp(60);
            return Promise.resolve();
        }

        let temperature = this.findTemperature(thermometer);

        let onoff = undefined;
        if (vtMode === 'Off' || temperature > (targetTemp + hysteresis)) {
            onoff = false;
        } else if (temperature < (targetTemp - hysteresis)) {
            onoff = true;
        }

        if (onoff !== undefined) {
            this.setCapabilityValue('vt_onoff', onoff);
            for (let device in devices) {
                let d = devices[device];
                if (d.zone.name === zoneName && d.class === 'heater' && d.state.onoff !== onoff) {
                    await d.setCapabilityValue('onoff', onoff);
                    this.log(d.name + ' set to ' + onoff);
                }
            }
            if (onoff) {
                this._turnedOnTrigger.trigger(this);
                this.log('trigged thermostat turned on');
            } else {
                this._turnedOffTrigger.trigger();
                this.log('trigged thermostat turned off');
            }
        }

        this.scheduleCheckTemp(60);

        return Promise.resolve();
    }

    findZone(deviceId, zoneName, devices, zones) {
        this.log('findZone', deviceId, zoneName);
        _(devices)
            .filter(d => d.zone.name === zoneName)
            .filter(d => d.class === 'thermostat')
            .forEach(d => {
                this.log('thermostat', d.id, d.name, d.zone, d.data);
            });
        let zone = _(zones)
            .find(z => z.name === zoneName);
        this.log('zone', zone);
        return zone;
    }

    findThermometer(zoneName, devices) {
        let thermometer = _(devices)
            .filter(d => d.zone.name === zoneName)
            .find(d => d.class === 'sensor' && d.capabilities.measure_temperature);
        if (!thermometer) {
            this.log('no temperature sensor in zone', zoneName);
        }
        return thermometer;
    }

    findVtMode(opts) {
        let vtMode = opts && opts.vt_mode ? opts.vt_mode : undefined;
        if (!vtMode) {
            vtMode = this.getCapabilityValue('vt_mode');
        }
        if (!vtMode) {
            vtMode = 'Comfort';
            this.setCapabilityValue('vt_mode', vtMode);
        }
        return vtMode;
    }

    findTargetTemperature(opts, vtMode) {
        let targetTemp = opts && opts.target_temperature ? opts.target_temperature : undefined;
        if (!targetTemp) {
            targetTemp = this.getCapabilityValue('target_temperature');
        }
        if (!targetTemp) {
            targetTemp = this.getSetting(`${vtMode}_setpoint`);
        }
        if (!targetTemp) {
            this.log('no target_temperature defined');
        } else {
            this.log('target temperature', targetTemp);
        }
        return targetTemp;
    }

    findTemperature(thermometer) {
        let currentTemperature = this.getCapabilityValue('measure_temperature');
        let temperature = thermometer.state.measure_temperature;
        if (!currentTemperature || currentTemperature !== temperature) {
            this.setCapabilityValue('measure_temperature', temperature);
            this.log('trigged temperature change', temperature);
        }
        this.log('temperature', temperature);
        return temperature;
    }

}

module.exports = VThermoDevice;