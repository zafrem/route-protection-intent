#!/usr/bin/env node
'use strict';
Promise.resolve(require('../src/cli').main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
