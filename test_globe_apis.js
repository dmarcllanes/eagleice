const ThreeGlobe = require('three-globe').default;
const globe = new ThreeGlobe();
const props = Object.getOwnPropertyNames(Object.getPrototypeOf(globe));
console.log("METHODS:", props.filter(k => k.toLowerCase().includes('tile')));
