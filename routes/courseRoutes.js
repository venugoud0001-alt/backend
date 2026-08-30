const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateJWT, requireAdminRole } = require('../middleware/auth');

// Public Courses Catalog Endpoint
router.get(['/courses', '/courses/catalog'], async (req, res, next) => {
  try {
    const { data: courses, error } = await supabase
      .from('courses')
      .select('id, title, slug, price, installment_price, status, created_at')
      .in('status', ['PUBLISHED', 'ACTIVE'])
      .order('title', { ascending: true });

    if (error) throw error;
    res.status(200).json({ status: 'SUCCESS', courses: courses || [] });
  } catch (err) {
    next(err);
  }
});

// Authoritative Batches Endpoint (No Fake Batches)
router.get('/batches', async (req, res, next) => {
  try {
    const { data: batches, error } = await supabase
      .from('batches')
      .select('id, course_id, batch_name, batch_code, start_date, schedule, mode, capacity, enrolled_count, status')
      .neq('status', 'CLOSED')
      .order('start_date', { ascending: true });

    if (error) throw error;
    res.status(200).json({ status: 'SUCCESS', batches: batches || [] });
  } catch (err) {
    next(err);
  }
});

// Protected Admin Batch Creation Endpoint
router.post('/admin/create-batch', authenticateJWT, requireAdminRole, async (req, res, next) => {
  try {
    const { batchName, courseId, startDate, capacity = 50 } = req.body;
    if (!batchName || !courseId) {
      return res.status(400).json({ status: 'ERROR', message: 'batchName and courseId are required.' });
    }

    const batchCode = `BATCH_${Date.now().toString().slice(-6)}`;
    const { data: newBatch, error } = await supabase.from('batches').insert([{
      course_id: courseId,
      batch_name: batchName,
      batch_code: batchCode,
      start_date: startDate || new Date().toISOString().split('T')[0],
      capacity,
      enrolled_count: 0,
      status: 'ACTIVE'
    }]).select().single();

    if (error) throw error;
    res.status(200).json({ status: 'SUCCESS', batch: newBatch });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
