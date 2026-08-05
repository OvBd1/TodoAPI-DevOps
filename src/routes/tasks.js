import express from 'express';
import { createTask, listTasks, getTask, updateTask, deleteTask } from '../controllers/task.js';
import { marquerPrefixe } from '../metrics.js';

const router = express.Router();

router.use(marquerPrefixe);

router.post('/', createTask);
router.get('/', listTasks);
router.get('/:id', getTask);
router.put('/:id', updateTask);
router.delete('/:id', deleteTask);

export default router;
