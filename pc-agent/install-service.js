const Service = require('node-windows').Service;
const path = require('path');

// Create a new service object
const svc = new Service({
  name: 'DYCICLMS PC Agent',
  description: 'PC Agent for DYCICLMS - Monitors and controls lab computers',
  script: path.join(__dirname, 'agent.js'),
  env: [
    {
      name: 'SERVER_URL',
      value: 'http://localhost:3001'
    },
    {
      name: 'AGENT_TOKEN',
      value: 'your-agent-token-here'
    }
  ]
});

// Listen for the "install" event
svc.on('install', () => {
  console.log('Service installed successfully');
  console.log('Starting service...');
  svc.start();
});

// Listen for the "alreadyinstalled" event
svc.on('alreadyinstalled', () => {
  console.log('Service is already installed');
  console.log('Starting service...');
  svc.start();
});

// Listen for the "start" event
svc.on('start', () => {
  console.log('Service started successfully');
});

// Install the service
console.log('Installing DYCICLMS PC Agent service...');
svc.install();
