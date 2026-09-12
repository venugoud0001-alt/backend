/**
 * Dynamic Student Learning Streak Service
 * Aggregates verified learning events from video_analytics_events and lesson_video_progress.
 * Computes consecutive learning streaks, weekly Monday-Sunday breakdown, and daily study goals.
 */

const { supabase } = require('../../config/supabase');

class StreakService {
  /**
   * Formats a Date object to YYYY-MM-DD in local/provided timezone (default UTC/IST)
   */
  formatDateKey(date) {
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Get 7 days of the current week (Monday through Sunday)
   */
  getCurrentWeekDays(referenceDate = new Date()) {
    const today = new Date(referenceDate);
    // getDay: 0 (Sun), 1 (Mon), ..., 6 (Sat)
    const dayOfWeek = today.getDay();
    // Monday is 0 offset, Tuesday is 1, ..., Sunday is 6
    const diffToMonday = (dayOfWeek + 6) % 7;

    const monday = new Date(today);
    monday.setDate(today.getDate() - diffToMonday);
    monday.setHours(0, 0, 0, 0);

    const dayLetters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    const week = [];
    const todayKey = this.formatDateKey(today);

    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dateKey = this.formatDateKey(d);

      week.push({
        index: i,
        day: dayLetters[i],
        name: dayNames[i],
        date: dateKey,
        isToday: dateKey === todayKey,
        isFuture: d > today && dateKey !== todayKey,
        done: false,
        minutes: 0,
        eventsCount: 0
      });
    }

    return { week, todayKey };
  }

  /**
   * Resolves student profile from user session or email
   */
  async resolveStudent(user, queryEmail = null) {
    const targetEmail = (queryEmail || user?.email || '').toLowerCase().trim();
    if (!targetEmail) return null;

    const { data: student } = await supabase
      .from('students')
      .select('id, email, full_name')
      .ilike('email', targetEmail)
      .maybeSingle();

    return student || null;
  }

  /**
   * Main streak computation
   */
  async getStudentStreak(user, queryEmail = null, timezoneOffsetMinutes = 0) {
    const student = await this.resolveStudent(user, queryEmail);
    const now = new Date();

    const { week, todayKey } = this.getCurrentWeekDays(now);
    const dailyGoalMinutes = 20;

    if (!student) {
      // Default empty streak state for guest or unauthenticated
      return {
        status: 'SUCCESS',
        currentStreak: 0,
        longestStreak: 0,
        todayMinutes: 0,
        dailyGoalMinutes,
        isGoalCompletedToday: false,
        weekDays: week,
        totalDaysActive: 0,
        message: 'Study 20 minutes today to start your learning streak and unlock milestone badges.'
      };
    }

    // 1. Query verified video analytics events for this student (last 60 days)
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
    
    let analyticsEvents = [];
    try {
      const { data: evts, error: evErr } = await supabase
        .from('video_analytics_events')
        .select('event_type, position_seconds, duration_seconds, event_timestamp, created_at')
        .eq('student_id', student.id)
        .gte('created_at', sixtyDaysAgo);

      if (!evErr && Array.isArray(evts)) {
        analyticsEvents = evts;
      }
    } catch (err) {
      console.warn('⚠️ [Streak] Analytics events fetch notice:', err.message);
    }

    // 2. Query lesson_video_progress records for this student
    let progressRecords = [];
    try {
      const { data: progs, error: prErr } = await supabase
        .from('lesson_video_progress')
        .select('last_watched_at, updated_at, completed_at, created_at, watched_duration_seconds, is_completed')
        .eq('student_id', student.id);

      if (!prErr && Array.isArray(progs)) {
        progressRecords = progs;
      }
    } catch (err) {
      console.warn('⚠️ [Streak] Progress records fetch notice:', err.message);
    }

    // 3. Aggregate active sessions and duration by calendar date (YYYY-MM-DD)
    const dailyMap = new Map();

    const addActivity = (rawDate, seconds = 0, eventType = '') => {
      if (!rawDate) return;
      const key = this.formatDateKey(rawDate);
      if (!key) return;

      const existing = dailyMap.get(key) || { seconds: 0, minutes: 0, eventsCount: 0, hasCompleted: false };
      existing.seconds += Math.max(0, Number(seconds) || 0);
      existing.eventsCount += 1;
      if (eventType === 'VIDEO_COMPLETED' || eventType === 'COMPLETED') {
        existing.hasCompleted = true;
      }
      dailyMap.set(key, existing);
    };

    // Ingest analytics events
    analyticsEvents.forEach((ev) => {
      const ts = ev.event_timestamp || ev.created_at;
      let estSecs = 15;
      if (ev.event_type === 'VIDEO_HEARTBEAT' || ev.event_type === 'HEARTBEAT') {
        estSecs = 15;
      } else if (ev.event_type === 'VIDEO_PLAY' || ev.event_type === 'PLAY') {
        estSecs = 20;
      } else if (ev.event_type === 'VIDEO_COMPLETED' || ev.event_type === 'COMPLETED') {
        estSecs = 60;
      } else {
        estSecs = 10;
      }
      addActivity(ts, estSecs, ev.event_type);
    });

    // Ingest progress records
    progressRecords.forEach((pr) => {
      const ts = pr.last_watched_at || pr.updated_at || pr.completed_at || pr.created_at;
      const watched = Math.max(0, Number(pr.watched_duration_seconds) || 30);
      addActivity(ts, Math.min(watched, 1800), pr.is_completed ? 'COMPLETED' : '');
    });

    // Finalize minutes per day (at least 1 minute per active day if there was verified learning activity)
    for (const [key, data] of dailyMap.entries()) {
      data.minutes = Math.max(data.eventsCount > 0 ? 1 : 0, Math.round(data.seconds / 60));
      dailyMap.set(key, data);
    }

    // 4. Update the 7 week days with actual learning data
    week.forEach((item) => {
      const activity = dailyMap.get(item.date);
      if (activity && (activity.minutes > 0 || activity.eventsCount > 0)) {
        item.done = true;
        item.minutes = activity.minutes;
        item.eventsCount = activity.eventsCount;
      } else {
        item.done = false;
        item.minutes = 0;
        item.eventsCount = 0;
      }
    });

    // 5. Calculate Current Streak
    // A day is active if it had at least 1 verified study event or > 0 minutes
    const isDateActive = (dateKey) => {
      const act = dailyMap.get(dateKey);
      return Boolean(act && (act.minutes > 0 || act.eventsCount > 0));
    };

    const todayActive = isDateActive(todayKey);
    
    // Yesterday
    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(now.getDate() - 1);
    const yesterdayKey = this.formatDateKey(yesterdayDate);
    const yesterdayActive = isDateActive(yesterdayKey);

    let currentStreak = 0;
    const checkDate = new Date(now);

    if (todayActive) {
      // Streak includes today and walks backwards
      while (true) {
        const k = this.formatDateKey(checkDate);
        if (isDateActive(k)) {
          currentStreak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    } else if (yesterdayActive) {
      // Streak is active from yesterday, waiting for today's session
      checkDate.setDate(now.getDate() - 1);
      while (true) {
        const k = this.formatDateKey(checkDate);
        if (isDateActive(k)) {
          currentStreak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    } else {
      currentStreak = 0;
    }

    // 6. Calculate Longest Streak
    const allSortedActiveDates = Array.from(dailyMap.keys()).sort();
    let longestStreak = currentStreak;
    let tempStreak = 0;
    let prevTime = 0;

    for (const dStr of allSortedActiveDates) {
      const d = new Date(dStr + 'T00:00:00Z');
      const time = d.getTime();
      const oneDay = 24 * 60 * 60 * 1000;

      if (prevTime === 0 || time - prevTime === oneDay) {
        tempStreak++;
      } else if (time - prevTime > oneDay) {
        tempStreak = 1;
      }
      prevTime = time;
      if (tempStreak > longestStreak) {
        longestStreak = tempStreak;
      }
    }

    // 7. Today's minutes & goal message
    const todayActivity = dailyMap.get(todayKey);
    const todayMinutes = todayActivity ? todayActivity.minutes : 0;
    const isGoalCompletedToday = todayMinutes >= dailyGoalMinutes;

    let message = '';
    if (isGoalCompletedToday) {
      message = `🔥 Great job! You reached today's ${dailyGoalMinutes}-minute study goal and kept your streak alive.`;
    } else if (todayMinutes > 0) {
      const remaining = dailyGoalMinutes - todayMinutes;
      message = `You've studied ${todayMinutes}m of ${dailyGoalMinutes}m today. ${remaining}m remaining to lock in today's streak.`;
    } else if (currentStreak > 0) {
      message = `Study ${dailyGoalMinutes} minutes today to maintain your ${currentStreak}-day learning streak and unlock milestone badges.`;
    } else {
      message = `Study ${dailyGoalMinutes} minutes today to start your learning streak and unlock milestone badges.`;
    }

    return {
      status: 'SUCCESS',
      currentStreak,
      longestStreak: Math.max(longestStreak, currentStreak),
      todayMinutes,
      dailyGoalMinutes,
      isGoalCompletedToday,
      weekDays: week,
      totalDaysActive: allSortedActiveDates.length,
      message
    };
  }

  /**
   * Records a study heartbeat from active video player sessions
   */
  async recordHeartbeat(user, { durationSeconds = 15, courseId = null, moduleId = null, lessonId = null, email = null }) {
    const student = await this.resolveStudent(user, email);
    if (!student) {
      return { status: 'SUCCESS', message: 'No student record' };
    }

    const dur = Math.max(5, Math.min(300, Number(durationSeconds) || 15));
    const nowIso = new Date().toISOString();

    // Insert heartbeat analytics event
    try {
      await supabase
        .from('video_analytics_events')
        .insert({
          student_id: student.id,
          course_id: courseId || null,
          module_id: moduleId ? String(moduleId) : null,
          lesson_id: lessonId ? String(lessonId) : null,
          event_type: 'VIDEO_HEARTBEAT',
          duration_seconds: dur,
          position_seconds: 0,
          event_timestamp: nowIso,
          created_at: nowIso,
          metadata: { heartbeat_source: 'student_study_session' }
        });
    } catch (err) {
      console.warn('⚠️ [Streak] Record heartbeat notice:', err.message);
    }

    // Return updated streak
    return this.getStudentStreak(user, email);
  }
}

module.exports = new StreakService();
