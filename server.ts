import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Serve static files from root with clean URLs support
app.use(express.static(__dirname, { extensions: ['html', 'htm'] }));

// Redirect legacy studentmanagement route to student portal
app.get('/studentmanagement', (req, res) => {
  res.redirect('/student');
});

// Serve index.html as the fallback for home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start listening
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
