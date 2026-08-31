const { supabase } = require('../src/config/supabase');

async function restoreCurriculums() {
  const curriculums = await import('../../src/data/courseCurriculums.js');

  const courseCurriculumMapping = [
    { match: s => s.includes('cyber-security') || s.includes('cybersecurity'), curriculum: curriculums.cyberSecurityCurriculum, name: 'Cyber Security' },
    { match: s => s.includes('ai-machine-learning') || s === 'ai-ml' || s === 'ai-python' || s === 'ml-python' || s === 'live-upskilling-program', curriculum: curriculums.aiMachineLearningCurriculum, name: 'AI + ML' },
    { match: s => s.includes('full-stack'), curriculum: curriculums.fullStackWebDevCurriculum, name: 'Full Stack' },
    { match: s => s.includes('data-science'), curriculum: curriculums.dataScienceCurriculum, name: 'Data Science' },
    { match: s => s === 'python', curriculum: curriculums.pythonProgrammingCurriculum, name: 'Python' },
    { match: s => s.includes('dsa'), curriculum: curriculums.dsaPythonCurriculum, name: 'DSA' },
    { match: s => s.includes('cloud-devops') || s === 'devops', curriculum: curriculums.devopsCurriculum, name: 'DevOps' },
    { match: s => s.includes('cloud-computing') || s === 'cloud', curriculum: curriculums.cloudComputingCurriculum, name: 'Cloud' },
    { match: s => s.includes('autocad'), curriculum: curriculums.autocadCurriculum, name: 'AutoCAD' },
    { match: s => s.includes('embedded-vlsi') || s === 'vlsi', curriculum: curriculums.vlsiCurriculum, name: 'VLSI' },
    { match: s => s.includes('embedded-systems') || s === 'embedded', curriculum: curriculums.embeddedSystemsCurriculum, name: 'Embedded' },
    { match: s => s.includes('iot'), curriculum: curriculums.iotCurriculum, name: 'IoT' },
    { match: s => s.includes('sap-finance') || s === 'sap-erp' || s === 'sap', curriculum: curriculums.sapFicoCurriculum, name: 'SAP' },
    { match: s => s === 'finance', curriculum: curriculums.financeCurriculum, name: 'Finance' },
    { match: s => s.includes('business'), curriculum: curriculums.businessAnalyticsCurriculum, name: 'Business Analytics' },
  ];

  const { data: courses, error } = await supabase.from('courses').select('id, title, slug, curriculum_modules');
  if (error) {
    console.error('Error fetching courses:', error);
    return;
  }

  console.log('Auditing and restoring courses...');
  let restoredCount = 0;

  for (const course of courses) {
    const mods = course.curriculum_modules || [];
    const firstTitle = mods[0]?.title || mods[0]?.name || '';
    const isMissingModule1 = !firstTitle.toLowerCase().includes('module 1') && !firstTitle.toLowerCase().startsWith('1.');

    if (isMissingModule1) {
      const mapping = courseCurriculumMapping.find(m => m.match(course.slug));
      if (mapping && Array.isArray(mapping.curriculum) && mapping.curriculum.length > 0) {
        console.log(`[RESTORE] ${course.title} (${course.slug}) -> Restoring ${mapping.curriculum.length} modules (was ${mods.length}, first was: '${firstTitle}')`);
        const { error: updateErr } = await supabase
          .from('courses')
          .update({
            curriculum_modules: mapping.curriculum,
            updated_at: new Date().toISOString()
          })
          .eq('id', course.id);

        if (updateErr) {
          console.error(`❌ Failed to update ${course.title}:`, updateErr.message);
        } else {
          restoredCount++;
        }
      } else {
        console.warn(`⚠️ No master curriculum mapping for ${course.title} (${course.slug})`);
      }
    } else {
      console.log(`[OK] ${course.title} already starts with Module 1 (${mods.length} modules)`);
    }
  }

  console.log(`\n🎉 Done! Restored Module 1 for ${restoredCount} courses.`);
}

restoreCurriculums();
