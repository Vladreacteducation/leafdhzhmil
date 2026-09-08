import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'backend',
    message: 'Express server is running',
  });
});

app.get('/api', (req, res) => {
  res.json({ message: 'API ready' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
