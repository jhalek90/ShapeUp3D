import './ui/styles.css';
import { App } from './app/App';

const app = new App();

if (import.meta.env.DEV) Object.assign(window, { app });
