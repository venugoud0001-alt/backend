/**
 * Video Analytics Administrative Reporting Service
 * Phase 3: High-performance aggregated analytics reporting layer.
 * Strictly Read-Only queries using indexed PostgreSQL tables and views.
 * Zero external calls (No AWS calls), Zero N+1 queries.
 */

const { supabase } = require('../../config/supabase');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class VideoAnalyticsAdminService {
  /**
   * Resolves standard date range filters into parameterized ISO strings.
   * Supported filters: today, last7days, last30days, thisMonth, custom, all
   */
  resolveDateRange(dateFilter, customStart, customEnd) {
    const now = new Date();

    if (!dateFilter && !customStart && !customEnd) {
      return {
        filterName: 'last30days',
        startDate: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        endDate: now.toISOString()
      };
    }

    const clean = String(dateFilter || '').toLowerCase().trim();

    switch (clean) {
      case 'today': {
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
        return {
          filterName: 'today',
          startDate: start.toISOString(),
          endDate: now.toISOString()
        };
      }
      case 'last7days': {
        const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return {
          filterName: 'last7days',
          startDate: start.toISOString(),
          endDate: now.toISOString()
        };
      }
      case 'last30days': {
        const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        return {
          filterName: 'last30days',
          startDate: start.toISOString(),
          endDate: now.toISOString()
        };
      }
      case 'thismonth': {
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
        return {
          filterName: 'thisMonth',
          startDate: start.toISOString(),
          endDate: now.toISOString()
        };
      }
      case 'all': {
        return {
          filterName: 'all',
          startDate: '1970-01-01T00:00:00.000Z',
          endDate: now.toISOString()
        };
      }
      case 'custom':
      default: {
        if (customStart && !isNaN(Date.parse(customStart))) {
          const start = new Date(customStart).toISOString();
          const end = customEnd && !isNaN(Date.parse(customEnd))
            ? new Date(customEnd).toISOString()
            : now.toISOString();
          return {
            filterName: 'custom',
            startDate: start,
            endDate: end
          };
        }
        const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        return {
          filterName: 'last30days',
          startDate: start.toISOString(),
          endDate: now.toISOString()
        };
      }
    }
  }

  /**
   * Calculates rewatch count following Phase 2 documented definition:
   * First qualifying session for (student, topic) = initial view.
   * Subsequent qualifying sessions for the same (student, topic) = rewatch.
   */
  calculateRewatchCount(events) {
    if (!Array.isArray(events) || events.length === 0) return 0;

    const studentTopicSessions = new Map();
    for (const e of events) {
      if (!e.student_id || !e.topic_id || !e.session_id) continue;
      if (e.event_type !== 'VIDEO_SESSION_STARTED' && e.event_type !== 'VIDEO_PLAY') continue;

      const key = `${e.student_id}:${e.topic_id}`;
      if (!studentTopicSessions.has(key)) {
        studentTopicSessions.set(key, new Set());
      }
      studentTopicSessions.get(key).add(e.session_id);
    }

    let rewatches = 0;
    for (const sessions of studentTopicSessions.values()) {
      if (sessions.size > 1) {
        rewatches += (sessions.size - 1);
      }
    }
    return rewatches;
  }

  /**
   * Calculates watch time safely from heartbeat events (15s default interval)
   */
  calculateWatchTime(events) {
    if (!Array.isArray(events) || events.length === 0) return 0;

    let totalSeconds = 0;
    for (const e of events) {
      if (e.event_type === 'VIDEO_HEARTBEAT') {
        const beatSec = Number(e.metadata?.heartbeat_interval_seconds) || 15;
        totalSeconds += beatSec;
      }
    }
    return Math.round(totalSeconds * 10) / 10;
  }

  /**
   * 1. GET OVERVIEW METRICS
   */
  async getOverviewMetrics({ dateFilter, startDate: customStart, endDate: customEnd } = {}) {
    const dateRange = this.resolveDateRange(dateFilter, customStart, customEnd);

    // Fetch indexed events within date range (only required columns)
    const { data: events, error } = await supabase
      .from('video_analytics_events')
      .select('student_id, session_id, topic_id, event_type, completion_percentage, metadata, event_timestamp')
      .gte('event_timestamp', dateRange.startDate)
      .lte('event_timestamp', dateRange.endDate);

    if (error) {
      console.error('⚠️ [Overview Metrics DB Error]:', error.message);
      throw { statusCode: 500, message: 'Failed to retrieve video analytics overview.' };
    }

    const safeEvents = events || [];

    // Distinct aggregations
    const uniqueViewersSet = new Set();
    const sessionsSet = new Set();
    const completedViewersSet = new Set();
    let totalPlays = 0;
    let completionSum = 0;
    let completionCount = 0;

    for (const e of safeEvents) {
      if (e.student_id) uniqueViewersSet.add(e.student_id);
      if (e.session_id) sessionsSet.add(e.session_id);

      if (e.event_type === 'VIDEO_PLAY') {
        totalPlays++;
      }

      if (e.event_type === 'VIDEO_COMPLETED' && e.student_id) {
        completedViewersSet.add(e.student_id);
      }

      if (typeof e.completion_percentage === 'number' && e.completion_percentage >= 0) {
        completionSum += e.completion_percentage;
        completionCount++;
      }
    }

    const uniqueViewers = uniqueViewersSet.size;
    const sessions = sessionsSet.size;
    const rewatchCount = this.calculateRewatchCount(safeEvents);
    const totalWatchTimeSeconds = this.calculateWatchTime(safeEvents);
    const averageWatchTimeSeconds = uniqueViewers > 0
      ? Math.round((totalWatchTimeSeconds / uniqueViewers) * 10) / 10
      : 0;
    const averageCompletion = completionCount > 0
      ? Math.round((completionSum / completionCount) * 100) / 100
      : 0;
    const completedViewers = completedViewersSet.size;
    const averagePlaysPerViewer = uniqueViewers > 0
      ? Math.round((totalPlays / uniqueViewers) * 100) / 100
      : 0;

    return {
      dateRange,
      metrics: {
        uniqueViewers,
        sessions,
        plays: totalPlays,
        rewatchCount,
        totalWatchTimeSeconds,
        averageWatchTimeSeconds,
        averageCompletion,
        averageCompletionPercentage: averageCompletion,
        completedViewers,
        averagePlaysPerViewer
      }
    };
  }

  /**
   * 2. GET TOPIC METRICS
   */
  async getTopicMetrics(topicId, { dateFilter, startDate: customStart, endDate: customEnd } = {}) {
    if (!topicId || !UUID_REGEX.test(topicId)) {
      throw { statusCode: 400, message: 'Invalid or missing topicId. Must be a valid UUID.' };
    }

    const dateRange = this.resolveDateRange(dateFilter, customStart, customEnd);

    // Fetch topic record
    const { data: topic, error: topicErr } = await supabase
      .from('topics')
      .select('id, title, module_id, course_id, duration_seconds')
      .eq('id', topicId)
      .maybeSingle();

    if (topicErr || !topic) {
      throw { statusCode: 404, message: 'Topic not found.' };
    }

    // Fetch indexed events for this topic within date range
    const { data: events, error } = await supabase
      .from('video_analytics_events')
      .select('student_id, session_id, event_type, completion_percentage, metadata, event_timestamp')
      .eq('topic_id', topicId)
      .gte('event_timestamp', dateRange.startDate)
      .lte('event_timestamp', dateRange.endDate)
      .order('event_timestamp', { ascending: false });

    if (error) {
      console.error('⚠️ [Topic Metrics DB Error]:', error.message);
      throw { statusCode: 500, message: 'Failed to retrieve topic metrics.' };
    }

    const safeEvents = events || [];

    const uniqueViewersSet = new Set();
    const sessionsSet = new Set();
    const completedStudentsSet = new Set();
    let plays = 0;
    let completionSum = 0;
    let completionCount = 0;
    let lastActivity = safeEvents.length > 0 ? safeEvents[0].event_timestamp : null;

    for (const e of safeEvents) {
      if (e.student_id) uniqueViewersSet.add(e.student_id);
      if (e.session_id) sessionsSet.add(e.session_id);

      if (e.event_type === 'VIDEO_PLAY') {
        plays++;
      }

      if (e.event_type === 'VIDEO_COMPLETED' && e.student_id) {
        completedStudentsSet.add(e.student_id);
      }

      if (typeof e.completion_percentage === 'number' && e.completion_percentage >= 0) {
        completionSum += e.completion_percentage;
        completionCount++;
      }
    }

    // Include topic_id in events for rewatch calculation
    const eventsWithTopic = safeEvents.map(e => ({ ...e, topic_id: topicId }));
    const rewatches = this.calculateRewatchCount(eventsWithTopic);
    const watchTimeSeconds = this.calculateWatchTime(safeEvents);
    const uniqueViewers = uniqueViewersSet.size;
    const averageWatchTime = uniqueViewers > 0
      ? Math.round((watchTimeSeconds / uniqueViewers) * 10) / 10
      : 0;
    const averageCompletion = completionCount > 0
      ? Math.round((completionSum / completionCount) * 100) / 100
      : 0;

    return {
      topic: {
        id: topic.id,
        title: topic.title,
        moduleId: topic.module_id,
        courseId: topic.course_id,
        durationSeconds: topic.duration_seconds || 0
      },
      dateRange,
      metrics: {
        uniqueViewers,
        sessions: sessionsSet.size,
        plays,
        rewatches,
        watchTimeSeconds,
        averageWatchTime,
        averageCompletion,
        completedStudents: completedStudentsSet.size,
        lastActivity
      }
    };
  }

  /**
   * 3. GET COURSE ANALYTICS (Aggregated course + modules + topics without N+1)
   */
  async getCourseAnalytics(courseId, { dateFilter, startDate: customStart, endDate: customEnd } = {}) {
    if (!courseId || !UUID_REGEX.test(courseId)) {
      throw { statusCode: 400, message: 'Invalid or missing courseId. Must be a valid UUID.' };
    }

    const dateRange = this.resolveDateRange(dateFilter, customStart, customEnd);

    // Fetch course details & its topics in parallel batch
    const [courseRes, topicsRes] = await Promise.all([
      supabase.from('courses').select('id, title, curriculum_modules').eq('id', courseId).maybeSingle(),
      supabase.from('topics').select('id, module_id, title, duration_seconds').eq('course_id', courseId)
    ]);

    if (courseRes.error || !courseRes.data) {
      throw { statusCode: 404, message: 'Course not found.' };
    }

    const course = courseRes.data;
    const courseTopics = topicsRes.data || [];
    const topicMap = new Map(courseTopics.map(t => [t.id, t]));

    // Fetch all course events in date range in one indexed query
    const { data: events, error: evErr } = await supabase
      .from('video_analytics_events')
      .select('student_id, session_id, module_id, topic_id, event_type, completion_percentage, metadata, event_timestamp')
      .eq('course_id', courseId)
      .gte('event_timestamp', dateRange.startDate)
      .lte('event_timestamp', dateRange.endDate);

    if (evErr) {
      console.error('⚠️ [Course Analytics DB Error]:', evErr.message);
      throw { statusCode: 500, message: 'Failed to retrieve course analytics.' };
    }

    const safeEvents = events || [];

    // Course summary metrics
    const courseViewersSet = new Set();
    const courseSessionsSet = new Set();
    const courseCompletedSet = new Set();
    let coursePlays = 0;
    let courseCompletionSum = 0;
    let courseCompletionCount = 0;

    // Grouping accumulators for modules and topics
    const moduleMap = new Map();
    const topicAggMap = new Map();

    for (const e of safeEvents) {
      if (e.student_id) courseViewersSet.add(e.student_id);
      if (e.session_id) courseSessionsSet.add(e.session_id);

      if (e.event_type === 'VIDEO_PLAY') coursePlays++;
      if (e.event_type === 'VIDEO_COMPLETED' && e.student_id) courseCompletedSet.add(e.student_id);

      if (typeof e.completion_percentage === 'number') {
        courseCompletionSum += e.completion_percentage;
        courseCompletionCount++;
      }

      // Group by module
      const modId = String(e.module_id || 'unknown');
      if (!moduleMap.has(modId)) {
        moduleMap.set(modId, {
          moduleId: modId,
          viewers: new Set(),
          sessions: new Set(),
          plays: 0,
          events: [],
          completionSum: 0,
          completionCount: 0
        });
      }
      const mAgg = moduleMap.get(modId);
      if (e.student_id) mAgg.viewers.add(e.student_id);
      if (e.session_id) mAgg.sessions.add(e.session_id);
      if (e.event_type === 'VIDEO_PLAY') mAgg.plays++;
      if (typeof e.completion_percentage === 'number') {
        mAgg.completionSum += e.completion_percentage;
        mAgg.completionCount++;
      }
      mAgg.events.push(e);

      // Group by topic
      if (e.topic_id) {
        const topId = e.topic_id;
        if (!topicAggMap.has(topId)) {
          topicAggMap.set(topId, {
            topicId: topId,
            moduleId: modId,
            viewers: new Set(),
            sessions: new Set(),
            completedStudents: new Set(),
            plays: 0,
            events: [],
            completionSum: 0,
            completionCount: 0
          });
        }
        const tAgg = topicAggMap.get(topId);
        if (e.student_id) tAgg.viewers.add(e.student_id);
        if (e.session_id) tAgg.sessions.add(e.session_id);
        if (e.event_type === 'VIDEO_PLAY') tAgg.plays++;
        if (e.event_type === 'VIDEO_COMPLETED' && e.student_id) tAgg.completedStudents.add(e.student_id);
        if (typeof e.completion_percentage === 'number') {
          tAgg.completionSum += e.completion_percentage;
          tAgg.completionCount++;
        }
        tAgg.events.push(e);
      }
    }

    const uniqueViewers = courseViewersSet.size;
    const rewatchCount = this.calculateRewatchCount(safeEvents);
    const totalWatchTimeSeconds = this.calculateWatchTime(safeEvents);
    const averageWatchTimeSeconds = uniqueViewers > 0
      ? Math.round((totalWatchTimeSeconds / uniqueViewers) * 10) / 10
      : 0;
    const averageCompletion = courseCompletionCount > 0
      ? Math.round((courseCompletionSum / courseCompletionCount) * 100) / 100
      : 0;

    // Build modules rollup with titles from curriculum_modules
    const curriculumModules = Array.isArray(course.curriculum_modules) ? course.curriculum_modules : [];
    const moduleList = [];

    for (const [modId, mAgg] of moduleMap.entries()) {
      const modMeta = curriculumModules.find((m, idx) => String(m.id !== undefined ? m.id : idx + 1) === modId);
      const modWatchTime = this.calculateWatchTime(mAgg.events);
      const modTopicsCount = courseTopics.filter(t => String(t.module_id) === modId).length;

      moduleList.push({
        moduleId: modId,
        title: modMeta?.title || modMeta?.name || `Module ${modId}`,
        uniqueViewers: mAgg.viewers.size,
        sessions: mAgg.sessions.size,
        plays: mAgg.plays,
        watchTimeSeconds: modWatchTime,
        averageCompletion: mAgg.completionCount > 0 ? Math.round((mAgg.completionSum / mAgg.completionCount) * 100) / 100 : 0,
        topicsCount: modTopicsCount
      });
    }

    // Build topics rollup with titles from topicMap
    const topicList = [];
    for (const [topId, tAgg] of topicAggMap.entries()) {
      const topMeta = topicMap.get(topId);
      const topWatchTime = this.calculateWatchTime(tAgg.events);
      const topRewatches = this.calculateRewatchCount(tAgg.events);

      topicList.push({
        topicId: topId,
        title: topMeta?.title || 'Unknown Topic',
        moduleId: tAgg.moduleId,
        uniqueViewers: tAgg.viewers.size,
        sessions: tAgg.sessions.size,
        plays: tAgg.plays,
        rewatchCount: topRewatches,
        watchTimeSeconds: topWatchTime,
        averageCompletion: tAgg.completionCount > 0 ? Math.round((tAgg.completionSum / tAgg.completionCount) * 100) / 100 : 0,
        completedStudents: tAgg.completedStudents.size
      });
    }

    return {
      course: {
        id: course.id,
        title: course.title
      },
      dateRange,
      metrics: {
        uniqueViewers,
        sessions: courseSessionsSet.size,
        plays: coursePlays,
        rewatchCount,
        totalWatchTimeSeconds,
        averageWatchTimeSeconds,
        averageCompletionPercentage: averageCompletion,
        completedStudents: courseCompletedSet.size
      },
      modules: moduleList,
      topics: topicList
    };
  }

  /**
   * 4. GET MODULE ANALYTICS
   */
  async getModuleAnalytics(moduleId, { dateFilter, startDate: customStart, endDate: customEnd } = {}) {
    if (!moduleId && moduleId !== 0) {
      throw { statusCode: 400, message: 'Invalid or missing moduleId.' };
    }

    const cleanModuleId = String(moduleId).trim();
    const dateRange = this.resolveDateRange(dateFilter, customStart, customEnd);

    // Fetch topics in this module
    const { data: topics, error: topErr } = await supabase
      .from('topics')
      .select('id, module_id, course_id, title, duration_seconds')
      .eq('module_id', cleanModuleId);

    if (topErr) {
      console.error('⚠️ [Module Topics DB Error]:', topErr.message);
    }

    const topicList = topics || [];
    const topicMap = new Map(topicList.map(t => [t.id, t]));
    const resolvedCourseId = topicList[0]?.course_id || null;

    // Fetch module events in date range
    const { data: events, error } = await supabase
      .from('video_analytics_events')
      .select('student_id, session_id, topic_id, course_id, event_type, completion_percentage, metadata, event_timestamp')
      .eq('module_id', cleanModuleId)
      .gte('event_timestamp', dateRange.startDate)
      .lte('event_timestamp', dateRange.endDate);

    if (error) {
      console.error('⚠️ [Module Analytics DB Error]:', error.message);
      throw { statusCode: 500, message: 'Failed to retrieve module analytics.' };
    }

    const safeEvents = events || [];

    const viewersSet = new Set();
    const sessionsSet = new Set();
    const completedStudentsSet = new Set();
    let plays = 0;
    let completionSum = 0;
    let completionCount = 0;

    const topicAggMap = new Map();

    for (const e of safeEvents) {
      if (e.student_id) viewersSet.add(e.student_id);
      if (e.session_id) sessionsSet.add(e.session_id);
      if (e.event_type === 'VIDEO_PLAY') plays++;
      if (e.event_type === 'VIDEO_COMPLETED' && e.student_id) completedStudentsSet.add(e.student_id);

      if (typeof e.completion_percentage === 'number') {
        completionSum += e.completion_percentage;
        completionCount++;
      }

      if (e.topic_id) {
        if (!topicAggMap.has(e.topic_id)) {
          topicAggMap.set(e.topic_id, {
            topicId: e.topic_id,
            viewers: new Set(),
            sessions: new Set(),
            completed: new Set(),
            plays: 0,
            events: [],
            completionSum: 0,
            completionCount: 0
          });
        }
        const tAgg = topicAggMap.get(e.topic_id);
        if (e.student_id) tAgg.viewers.add(e.student_id);
        if (e.session_id) tAgg.sessions.add(e.session_id);
        if (e.event_type === 'VIDEO_PLAY') tAgg.plays++;
        if (e.event_type === 'VIDEO_COMPLETED' && e.student_id) tAgg.completed.add(e.student_id);
        if (typeof e.completion_percentage === 'number') {
          tAgg.completionSum += e.completion_percentage;
          tAgg.completionCount++;
        }
        tAgg.events.push(e);
      }
    }

    const uniqueViewers = viewersSet.size;
    const rewatchCount = this.calculateRewatchCount(safeEvents);
    const totalWatchTimeSeconds = this.calculateWatchTime(safeEvents);
    const averageWatchTime = uniqueViewers > 0
      ? Math.round((totalWatchTimeSeconds / uniqueViewers) * 10) / 10
      : 0;
    const averageCompletion = completionCount > 0
      ? Math.round((completionSum / completionCount) * 100) / 100
      : 0;

    const topicsRollup = [];
    for (const [topId, tAgg] of topicAggMap.entries()) {
      const topMeta = topicMap.get(topId);
      topicsRollup.push({
        topicId: topId,
        title: topMeta?.title || 'Unknown Topic',
        uniqueViewers: tAgg.viewers.size,
        sessions: tAgg.sessions.size,
        plays: tAgg.plays,
        rewatchCount: this.calculateRewatchCount(tAgg.events),
        watchTimeSeconds: this.calculateWatchTime(tAgg.events),
        averageCompletion: tAgg.completionCount > 0 ? Math.round((tAgg.completionSum / tAgg.completionCount) * 100) / 100 : 0,
        completedStudents: tAgg.completed.size
      });
    }

    return {
      moduleId: cleanModuleId,
      courseId: resolvedCourseId,
      dateRange,
      metrics: {
        uniqueViewers,
        sessions: sessionsSet.size,
        plays,
        rewatchCount,
        totalWatchTimeSeconds,
        averageWatchTimeSeconds: averageWatchTime,
        averageCompletionPercentage: averageCompletion,
        completedStudents: completedStudentsSet.size
      },
      topics: topicsRollup
    };
  }

  /**
   * 5. GET STUDENTS ANALYTICS (Paginated, Searchable)
   */
  async getStudentsAnalytics({ dateFilter, startDate: customStart, endDate: customEnd, page = 1, limit = 20, search = '' } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;
    const dateRange = this.resolveDateRange(dateFilter, customStart, customEnd);

    // Query distinct students with video activity in this date range
    const { data: activeEvents, error } = await supabase
      .from('video_analytics_events')
      .select('student_id, session_id, topic_id, event_type, completion_percentage, metadata, event_timestamp')
      .not('student_id', 'is', null)
      .gte('event_timestamp', dateRange.startDate)
      .lte('event_timestamp', dateRange.endDate);

    if (error) {
      console.error('⚠️ [Students Analytics DB Error]:', error.message);
      throw { statusCode: 500, message: 'Failed to retrieve students analytics.' };
    }

    const safeEvents = activeEvents || [];

    // Aggregate by student_id
    const studentAggMap = new Map();
    for (const e of safeEvents) {
      if (!e.student_id) continue;
      if (!studentAggMap.has(e.student_id)) {
        studentAggMap.set(e.student_id, {
          studentId: e.student_id,
          topicsSet: new Set(),
          sessionsSet: new Set(),
          plays: 0,
          events: [],
          completionSum: 0,
          completionCount: 0,
          lastWatched: e.event_timestamp
        });
      }
      const sAgg = studentAggMap.get(e.student_id);
      if (e.topic_id) sAgg.topicsSet.add(e.topic_id);
      if (e.session_id) sAgg.sessionsSet.add(e.session_id);
      if (e.event_type === 'VIDEO_PLAY') sAgg.plays++;
      if (typeof e.completion_percentage === 'number') {
        sAgg.completionSum += e.completion_percentage;
        sAgg.completionCount++;
      }
      if (new Date(e.event_timestamp) > new Date(sAgg.lastWatched)) {
        sAgg.lastWatched = e.event_timestamp;
      }
      sAgg.events.push(e);
    }

    const studentIds = Array.from(studentAggMap.keys());

    // Fetch student profile details from students table in a single indexed query
    let studentProfiles = [];
    if (studentIds.length > 0) {
      let query = supabase
        .from('students')
        .select('id, email, full_name');

      if (studentIds.length <= 1000) {
        query = query.in('id', studentIds);
      }
      const { data: profiles } = await query;
      studentProfiles = profiles || [];
    }

    const profileMap = new Map(studentProfiles.map(p => [p.id, p]));

    // Join aggregated metrics with profile information
    let mergedStudents = [];
    for (const [sId, sAgg] of studentAggMap.entries()) {
      const profile = profileMap.get(sId);
      const fullName = profile?.full_name || 'Student';
      const email = profile?.email || '';

      // Optional text search filter
      if (search && search.trim() !== '') {
        const q = search.toLowerCase().trim();
        if (!fullName.toLowerCase().includes(q) && !email.toLowerCase().includes(q)) {
          continue;
        }
      }

      const watchTime = this.calculateWatchTime(sAgg.events);
      const rewatches = this.calculateRewatchCount(sAgg.events);
      const avgCompletion = sAgg.completionCount > 0
        ? Math.round((sAgg.completionSum / sAgg.completionCount) * 100) / 100
        : 0;

      mergedStudents.push({
        studentId: sId,
        fullName,
        email,
        topicsViewed: sAgg.topicsSet.size,
        sessions: sAgg.sessionsSet.size,
        plays: sAgg.plays,
        rewatches,
        watchTimeSeconds: watchTime,
        averageCompletion: avgCompletion,
        lastWatched: sAgg.lastWatched
      });
    }

    // Sort by lastWatched DESC
    mergedStudents.sort((a, b) => new Date(b.lastWatched) - new Date(a.lastWatched));

    const total = mergedStudents.length;
    const paginatedStudents = mergedStudents.slice(offset, offset + limitNum);

    return {
      dateRange,
      students: paginatedStudents,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1
      }
    };
  }

  /**
   * 6. GET SINGLE STUDENT ANALYTICS
   */
  async getSingleStudentAnalytics(studentId, { dateFilter, startDate: customStart, endDate: customEnd } = {}) {
    if (!studentId || !UUID_REGEX.test(studentId)) {
      throw { statusCode: 400, message: 'Invalid or missing studentId. Must be a valid UUID.' };
    }

    const dateRange = this.resolveDateRange(dateFilter, customStart, customEnd);

    // 1. Fetch Student Profile
    const { data: student, error: stuErr } = await supabase
      .from('students')
      .select('id, email, full_name')
      .eq('id', studentId)
      .maybeSingle();

    if (stuErr || !student) {
      throw { statusCode: 404, message: 'Student profile not found.' };
    }

    // 2. Fetch Events for this student within date range
    const { data: events, error } = await supabase
      .from('video_analytics_events')
      .select('session_id, course_id, module_id, topic_id, event_type, completion_percentage, metadata, event_timestamp')
      .eq('student_id', studentId)
      .gte('event_timestamp', dateRange.startDate)
      .lte('event_timestamp', dateRange.endDate)
      .order('event_timestamp', { ascending: false });

    if (error) {
      console.error('⚠️ [Single Student DB Error]:', error.message);
      throw { statusCode: 500, message: 'Failed to retrieve student analytics.' };
    }

    const safeEvents = events || [];

    const topicsSet = new Set();
    const sessionsSet = new Set();
    let plays = 0;
    let completionSum = 0;
    let completionCount = 0;
    const topicHistoryMap = new Map();

    for (const e of safeEvents) {
      if (e.topic_id) topicsSet.add(e.topic_id);
      if (e.session_id) sessionsSet.add(e.session_id);
      if (e.event_type === 'VIDEO_PLAY') plays++;
      if (typeof e.completion_percentage === 'number') {
        completionSum += e.completion_percentage;
        completionCount++;
      }

      if (e.topic_id) {
        if (!topicHistoryMap.has(e.topic_id)) {
          topicHistoryMap.set(e.topic_id, {
            topicId: e.topic_id,
            courseId: e.course_id,
            moduleId: e.module_id,
            sessions: new Set(),
            plays: 0,
            events: [],
            maxCompletion: 0,
            completed: false,
            lastWatched: e.event_timestamp
          });
        }
        const th = topicHistoryMap.get(e.topic_id);
        if (e.session_id) th.sessions.add(e.session_id);
        if (e.event_type === 'VIDEO_PLAY') th.plays++;
        if (e.event_type === 'VIDEO_COMPLETED') th.completed = true;
        if (typeof e.completion_percentage === 'number' && e.completion_percentage > th.maxCompletion) {
          th.maxCompletion = e.completion_percentage;
        }
        th.events.push(e);
      }
    }

    // Enrich topic titles in a single batch
    const topicIds = Array.from(topicHistoryMap.keys());
    let topicTitlesMap = new Map();
    if (topicIds.length > 0) {
      const { data: tData } = await supabase.from('topics').select('id, title').in('id', topicIds);
      topicTitlesMap = new Map((tData || []).map(t => [t.id, t.title]));
    }

    const topicsRollup = [];
    for (const [topId, th] of topicHistoryMap.entries()) {
      // Include student_id for rewatch helper
      const eventsWithStudent = th.events.map(ev => ({ ...ev, student_id: studentId, topic_id: topId }));
      topicsRollup.push({
        topicId: topId,
        topicTitle: topicTitlesMap.get(topId) || 'Topic',
        courseId: th.courseId,
        moduleId: th.moduleId,
        sessions: th.sessions.size,
        plays: th.plays,
        rewatches: this.calculateRewatchCount(eventsWithStudent),
        watchTimeSeconds: this.calculateWatchTime(th.events),
        completionPercentage: th.maxCompletion,
        completed: th.completed,
        lastWatched: th.lastWatched
      });
    }

    // Ensure student events are tagged with student_id
    const studentEventsTagged = safeEvents.map(e => ({ ...e, student_id: studentId }));
    const totalRewatches = this.calculateRewatchCount(studentEventsTagged);
    const totalWatchTimeSeconds = this.calculateWatchTime(safeEvents);
    const averageCompletion = completionCount > 0
      ? Math.round((completionSum / completionCount) * 100) / 100
      : 0;

    return {
      student: {
        id: student.id,
        fullName: student.full_name,
        email: student.email
      },
      dateRange,
      metrics: {
        topicsViewed: topicsSet.size,
        sessions: sessionsSet.size,
        plays,
        rewatches: totalRewatches,
        watchTimeSeconds: totalWatchTimeSeconds,
        averageCompletion,
        lastWatched: safeEvents[0]?.event_timestamp || null
      },
      topics: topicsRollup
    };
  }

  /**
   * 7. GET TRENDS ANALYTICS (Daily time-series aggregation)
   */
  async getTrendsAnalytics({ dateFilter, startDate: customStart, endDate: customEnd } = {}) {
    const dateRange = this.resolveDateRange(dateFilter, customStart, customEnd);

    const { data: events, error } = await supabase
      .from('video_analytics_events')
      .select('student_id, session_id, event_type, metadata, event_timestamp')
      .gte('event_timestamp', dateRange.startDate)
      .lte('event_timestamp', dateRange.endDate)
      .order('event_timestamp', { ascending: true });

    if (error) {
      console.error('⚠️ [Trends DB Error]:', error.message);
      throw { statusCode: 500, message: 'Failed to retrieve video analytics trends.' };
    }

    const safeEvents = events || [];

    // Bucket by YYYY-MM-DD
    const dayBuckets = new Map();

    for (const e of safeEvents) {
      const day = e.event_timestamp ? e.event_timestamp.slice(0, 10) : 'unknown';
      if (!dayBuckets.has(day)) {
        dayBuckets.set(day, {
          date: day,
          plays: 0,
          viewers: new Set(),
          sessions: new Set(),
          events: []
        });
      }
      const b = dayBuckets.get(day);
      if (e.event_type === 'VIDEO_PLAY') b.plays++;
      if (e.student_id) b.viewers.add(e.student_id);
      if (e.session_id) b.sessions.add(e.session_id);
      b.events.push(e);
    }

    const trends = [];
    for (const [day, b] of dayBuckets.entries()) {
      trends.push({
        date: day,
        plays: b.plays,
        sessions: b.sessions.size,
        uniqueViewers: b.viewers.size,
        watchTimeSeconds: this.calculateWatchTime(b.events)
      });
    }

    trends.sort((a, b) => a.date.localeCompare(b.date));

    return {
      dateRange,
      trends
    };
  }
}

module.exports = new VideoAnalyticsAdminService();
