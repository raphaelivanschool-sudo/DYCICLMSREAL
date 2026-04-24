const Service = require('node-windows').Service;
const path = require('path');

// Create a new service object
const svc = new Service({
  name: 'DYCICLMS PC Agent',
  script: path.join(__dirname, 'agent.js')
});

// Listen for the "uninstall" event
svc.on('uninstall', () => {
  console.log('Service uninstalled successfully');
});

// Listen for the "doesnotexist" event
svc.on('doesnotexist', () => {
  console.log('Service does not exist');
});

// Uninstall the service
console.log('Uninstalling DYCICLMS PC Agent service...');
svc.uninstall();
