import { hydrateRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Initial state was serialized by the server into window.__INITIAL_STATE__
// so the first client render exactly matches the server-rendered HTML.
const initialState = window.__INITIAL_STATE__ ?? { components: [], slotAssignments: [] };

hydrateRoot(
  document.getElementById('root'),
  <App initialState={initialState} />
);
