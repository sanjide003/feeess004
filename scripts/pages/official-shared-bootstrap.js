import { signInAnonymously, onAuthStateChanged, signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
    import { collection, doc, getDoc, getDocs, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
    import { db, auth } from '../../config/firebase-config.js';
    import { BASE_PATH, applyCachedInstitutionLogo, escapeHtml, rememberInstitutionLogo, sanitizeUrl } from '../shared/app-common.js';
    import { registerPortalForPwa } from '../shared/pwa-install.js';

    let allStudents = [];
    let allStaff = [];
    let studentGroups = [];
    let directoryEntries = [];
    let directoryCategories = [];
    let academicYears = [];
    let activeAcademicYearId = '';
    let allFeeItems = [];
    let allPayments = [];
    let allExams = [];
    let allMarks = {};
    let institutionConfig = {};
    let categoryAuthConfig = { categories: {} };
    let pageAccessConfig = { categories: {}, overrides: {} };
    let userSession = null;
    let authReady = false;
    const OFFICIAL_SESSION_KEY = 'official_portal_session_v1';
    
    applyCachedInstitutionLogo(['header-logo', 'official-login-modal-logo']);

    const officialFilters = {
      academicYearId: '',
      studentClass: 'ALL',
      studentGender: 'ALL',
      studentStatus: 'ALL',
      studentInfo: 'ALL',
      studentSearch: '',
      studentPage: 1,
      studentPageSize: 25,
      staffType: 'ALL',
      staffStatus: 'ALL',
      staffSearch: '',
      alumniYear: 'ALL',
      alumniSearch: '',
      alumniPage: 1,
      alumniPageSize: 25
    };

    const isAlumniStudent = (student = {}) => {
      const cls = String(student.class || '').trim().toLowerCase();
      const st = String(student.status || '').trim().toLowerCase();
      return cls === 'alumni' || cls === 'graduated' || st === 'alumni' || st === 'graduated' || student.isAlumni === true;
    };

    const getAlumniGraduatedYear = (student = {}) => {
      return String(student.graduatedYear || student.academicYear || 'General Alumni').trim();
    };

    const extractStudentPhoto = (obj = {}) => {
      const prof = (obj?.profile && typeof obj.profile === 'object') ? obj.profile : {};
      const custom = (obj?.customValues && typeof obj.customValues === 'object') ? obj.customValues : {};
      const candidates = [
        obj?.photo, obj?.image, obj?.photoUrl, obj?.photo_url, obj?.avatar,
        prof?.photo, prof?.image, prof?.photoUrl, prof?.photo_url,
        custom?.photo, custom?.image
      ];
      for (const c of candidates) {
        if (typeof c === 'string') {
          const trimmed = c.trim();
          if (trimmed && !trimmed.includes('assets/images/logo.png')) return trimmed;
        }
      }
      return '';
    };

    const hasValidAvatarImage = (obj = {}) => {
      return Boolean(extractStudentPhoto(obj));
    };

    const getPersonInitials = (name = '') => {
      const clean = String(name || '').trim();
      if (!clean) return 'U';
      const parts = clean.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return clean.slice(0, 2).toUpperCase();
    };

    const renderAvatarMarkup = (obj = {}, name = '', sizeClass = 'w-9 h-9 rounded-xl text-xs') => {
      const initials = escapeHtml(getPersonInitials(name || obj?.name || 'User'));
      const gender = String(obj?.gender || obj?.profile?.gender || '').trim().toLowerCase();
      const toneClass = gender === 'female'
        ? 'bg-pink-100 text-pink-700 border-pink-200'
        : 'bg-indigo-100 text-indigo-700 border-indigo-200';
      if (hasValidAvatarImage(obj)) {
        const photoUrl = getPhoto(obj);
        return `
          <div class="relative ${sizeClass} overflow-hidden border border-slate-200 bg-slate-100 flex-shrink-0 mx-auto">
            <img src="${escapeHtml(photoUrl)}" alt="${escapeHtml(name || 'Profile')}" class="w-full h-full object-cover" onerror="this.style.display='none';this.nextElementSibling.classList.remove('hidden');">
            <div class="hidden w-full h-full flex items-center justify-center font-extrabold ${toneClass}">${initials}</div>
          </div>`;
      }
      return `<div class="${sizeClass} border ${toneClass} flex items-center justify-center font-extrabold flex-shrink-0 mx-auto select-none" title="${escapeHtml(name || 'User')}">${initials}</div>`;
    };

    const filterStudentByAcademicYear = (student = {}, selectedYear = '') => {
      if (isAlumniStudent(student)) return null;
      const targetYear = String(selectedYear || activeAcademicYearId || '').trim();
      if (!targetYear) {
        return student;
      }

      const yearRecord = student.academicYears?.[targetYear];
      if (yearRecord && typeof yearRecord === 'object') {
        const merged = {
          ...student,
          class: yearRecord.class || student.class,
          status: yearRecord.status || student.status,
          isActive: yearRecord.status ? yearRecord.status === 'active' : student.isActive,
          concessionFee: yearRecord.concessionFee !== undefined ? yearRecord.concessionFee : student.concessionFee
        };
        if (isAlumniStudent(merged)) return null;
        return merged;
      }

      const stuYear = String(student.academicYear || '').trim();
      if (stuYear) {
        if (stuYear !== targetYear) return null;
        return student;
      }

      if (!activeAcademicYearId || targetYear === activeAcademicYearId) {
        return student;
      }

      return null;
    };

    const getStudentForSelectedYear = (student = {}) => {
      const selectedYear = officialFilters.academicYearId || activeAcademicYearId;
      return filterStudentByAcademicYear(student, selectedYear);
    };

    const getStudentsForCurrentAcademicYear = () => {
      return allStudents.map(getStudentForSelectedYear).filter(Boolean);
    };

    // ==========================================
    // EXCEL SPREADSHEET BUILDER CONFIG
    // ==========================================
    let builderConfig = {
      sourceType: 'students', // 'students' | 'staff' | 'fees' | 'results'
      academicYearId: '',
      classId: 'ALL',
      staffCategory: 'ALL',
      examId: 'ALL',
      feeItemId: 'ALL',
      paper: 'A4',
      orientation: 'portrait',
      zoom: 100,
      sortBy: 'name',
      groupBy: 'mixed',
      borderMode: 'grid', // 'grid' | 'outer' | 'none'
      rowDensity: 'normal', // 'compact' | 'normal' | 'comfortable'
      showHeader: true,
      repeatHeader: true,
      showSignatures: false,
      sigLeft: 'Class Teacher',
      sigCenter: 'Checked By',
      sigRight: 'Principal / Head',
      customTitle: 'INSTITUTION WORKSHEET & REGISTER',
      customSubtitle: '',
      activeTab: 'data',
      columns: [
        { id: 'col_sno', field: 'SNO', title: 'S.No', width: '50px' },
        { id: 'col_adm', field: 'adm', title: 'Adm No.', width: '90px' },
        { id: 'col_name', field: 'name', title: 'Student Name', width: '200px' },
        { id: 'col_class', field: 'class', title: 'Class', width: '80px' },
        { id: 'col_mobile', field: 'mobile', title: 'Mobile', width: '120px' },
        { id: 'col_c1', field: 'CUSTOM', title: 'Remarks', width: '140px' }
      ]
    };

    let undoStack = [];
    let redoStack = [];

    const saveBuilderState = () => {
        const table = document.getElementById('builder-table');
        if (table) {
            undoStack.push(table.innerHTML);
            if (undoStack.length > 20) undoStack.shift(); 
            redoStack = [];
        }
    };

    const undoBuilder = () => {
        if (undoStack.length > 0) {
            const table = document.getElementById('builder-table');
            redoStack.push(table.innerHTML);
            table.innerHTML = undoStack.pop();
            attachTableFormatListeners();
            rebindAllColumnListeners();
        }
    };

    const redoBuilder = () => {
        if (redoStack.length > 0) {
            const table = document.getElementById('builder-table');
            undoStack.push(table.innerHTML);
            table.innerHTML = redoStack.pop();
            attachTableFormatListeners();
            rebindAllColumnListeners();
        }
    };

    const resolveInstitutionName = (conf = {}) => String(conf.appName || conf.institutionName || conf.institution || conf.schoolName || conf.school || conf.name || '').trim();

    const applyOfficialBranding = (conf = {}) => {
      institutionConfig = conf || {};
      const institutionName = resolveInstitutionName(conf) || 'Official Portal';
      const effectiveLogo = rememberInstitutionLogo(conf.logoUrl || '') || 'assets/images/logo.png';
      ['header-logo', 'official-login-modal-logo'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.src = effectiveLogo;
        el.onerror = () => { el.onerror = null; el.src = 'assets/images/logo.png'; };
      });
      document.getElementById('header-title').textContent = institutionName;
    };

    const hashCredentialValue = async (rawValue = '') => {
      const value = String(rawValue || '');
      if (!value) return '';
      if (!(window.crypto?.subtle)) return value;
      const encoded = new TextEncoder().encode(value);
      const digest = await window.crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };

    const showMsg = (m = '') => { document.getElementById('official-login-msg').textContent = m; };
    const toLabel = (key = '') => String(key || '').replace(/([A-Z])/g, ' $1').replace(/[_.-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
    const normalizeText = (value = '') => String(value || '').trim().toLowerCase();
    const formatDate = (value = '') => {
      if (!value) return '--';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-GB');
    };
    const formatDateIfIso = (val = '') => {
      if (!val) return '--';
      const str = String(val).trim();
      if (!str || str === '--') return '--';
      if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        const [y, m, d] = str.split('-');
        return `${d}/${m}/${y}`;
      }
      return str;
    };
    const valueToDisplay = (value) => {
      if (value === undefined || value === null || value === '') return '';
      if (Array.isArray(value)) return value.map(valueToDisplay).join(', ');
      if (typeof value === 'object') {
        if (value.seconds) return formatDate(value.seconds * 1000);
        return Object.entries(value).filter(([, nested]) => nested !== undefined && nested !== null && String(nested).trim() !== '').map(([key, nested]) => `${toLabel(key)}: ${valueToDisplay(nested)}`).join(' • ') || '';
      }
      return String(value);
    };
    const SENSITIVE_PROFILE_KEYS = new Set(['id', 'password', 'passwordhash', 'password_hash', 'username', 'user_name', 'usernameraw', 'username_raw', 'authmeta', 'source', 'email']);
    const isSensitiveProfileField = (key = '', label = '') => {
      const parts = [key, label].map((item) => String(item || '').toLowerCase().replace(/[\s.-]+/g, '_'));
      return parts.some((part) => SENSITIVE_PROFILE_KEYS.has(part) || /(^|_)pass(word)?($|_)/.test(part) || /(^|_)user(name)?($|_)/.test(part) || part.includes('credential') || part.includes('auth'));
    };
    const renderEntriesGrid = (entries = []) => {
      const visibleEntries = entries.filter((entry) => entry && !isSensitiveProfileField(entry.key, entry.label) && valueToDisplay(entry.value) !== '');
      if (!visibleEntries.length) return '<div class="text-sm text-slate-500">No details available.</div>';
      return `<div class="details-grid">${visibleEntries.map((entry) => `<div class="detail-item"><div class="detail-label">${escapeHtml(entry.label || toLabel(entry.key))}</div><div class="detail-value">${escapeHtml(valueToDisplay(entry.value))}</div></div>`).join('')}</div>`;
    };
    const getVisibleEntries = (obj = {}, skipKeys = []) => Object.entries(obj || {}).filter(([k, v]) => !skipKeys.includes(k) && v !== undefined && v !== null && String(valueToDisplay(v)).trim() !== '');
    const renderKeyValueGrid = (obj = {}, skipKeys = []) => renderEntriesGrid(getVisibleEntries(obj, skipKeys).map(([key, value]) => ({ key, label: toLabel(key), value })));
    const getPhoto = (obj = {}) => {
        const rawPhoto = extractStudentPhoto(obj) || obj.logo || '';
        return (rawPhoto && rawPhoto.startsWith('data:')) ? rawPhoto : (sanitizeUrl(rawPhoto) || 'assets/images/logo.png');
    };
    const getStudentClass = (student = {}) => String(student.class || '--').trim() || '--';
    const getStudentGender = (student = {}) => String(student.gender || '').trim();
    const getStudentStatus = (student = {}) => student.isActive === false || student.status === 'inactive' || student.left === true ? 'Inactive' : 'Active';
    const hasStudentConcession = (student = {}) => student.concessionFee !== undefined && student.concessionFee !== null && student.concessionFee !== '';
    const getStudentGroup = (studentId = '') => studentGroups.find((group) => Array.isArray(group.memberIds) && group.memberIds.includes(studentId));
    const getGroupMemberRows = (group = {}) => (group.memberIds || []).map((memberId) => allStudents.find((student) => student.id === memberId)).filter(Boolean);

    const getMobileToggle = () => document.getElementById('official-my-profile-btn') || document.getElementById('mobile-menu-btn');
    const getNavMenu = () => document.querySelector('.nav-menu');
    const setMobileMenuState = (isOpen) => {
      const menu = getNavMenu();
      const toggle = getMobileToggle();
      menu?.classList.toggle('active', isOpen);
      toggle?.classList.toggle('active-toggle', isOpen);
      toggle?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };

    const isWorksheetPage = window.location.pathname.toLowerCase().includes('worksheet') || document.body.dataset.pageType === 'worksheet';
    let officialPwa = null;
    if (!isWorksheetPage) {
      officialPwa = registerPortalForPwa('official', {
        menuItemId: 'official-install-menu-item',
        menuBtnId: 'official-install-btn'
      });
    }

    const setTab = (tab = 'dashboard') => {
      if (!isWorksheetPage && tab !== 'dashboard') {
        window.location.href = `worksheet.html#${tab}`;
        return;
      }
      if (isWorksheetPage && tab === 'dashboard') {
        window.location.href = 'official.html';
        return;
      }

      const defaultTab = isWorksheetPage ? 'summary' : 'dashboard';
      const requested = document.getElementById(`official-tab-${tab}`) ? tab : defaultTab;
      const target = document.getElementById(`official-tab-${requested}`) ? requested : defaultTab;
      document.querySelectorAll('.official-tab').forEach((el) => el.classList.add('hidden'));
      
      const pageContentWrap = document.getElementById('page-content');
      const targetEl = document.getElementById(`official-tab-${target}`);
      if(targetEl) {
          targetEl.classList.remove('hidden');
          if (target === 'export') {
              targetEl.classList.add('flex');
              pageContentWrap?.classList.add('hidden');
          } else {
              document.getElementById('official-tab-export')?.classList.remove('flex');
              pageContentWrap?.classList.remove('hidden');
          }
      }

      document.querySelectorAll('.tab-link').forEach((btn) => {
        const active = btn.dataset.tab === target;
        btn.classList.toggle('active', active);
        btn.classList.toggle('text-indigo-700', active);
      });
      setMobileMenuState(false);
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      
      if (target === 'export') {
          renderExportTab();
          setupExcelEngine();
      } else if (target === 'students') {
          renderStudents();
      } else if (target === 'alumni') {
          renderAlumniTab();
      } else if (target === 'staff') {
          renderStaffTab();
      } else if (target === 'summary') {
          buildClassSummary();
      }
    };

    const openOfficialDetailModal = (title = 'Details', bodyHtml = '') => {
      const titleEl = document.getElementById('official-detail-title');
      const bodyEl = document.getElementById('official-detail-body');
      const modal = document.getElementById('official-detail-modal');
      if (!titleEl || !bodyEl || !modal) return;
      titleEl.textContent = title;
      bodyEl.innerHTML = bodyHtml;
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('overflow-hidden');
    };
    const closeOfficialDetailModal = () => {
      const modal = document.getElementById('official-detail-modal');
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('overflow-hidden');
    };

    const closeIdCardModal = () => {
      const modal = document.getElementById('official-id-card-modal');
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('overflow-hidden');
    };

    const openIdCardModal = (cardHtml = '') => {
      const contentEl = document.getElementById('official-id-card-content');
      const modal = document.getElementById('official-id-card-modal');
      if (!contentEl || !modal) {
        openOfficialDetailModal('Staff ID Card', cardHtml);
        return;
      }
      contentEl.innerHTML = cardHtml;
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('overflow-hidden');
    };

    document.getElementById('official-detail-close')?.addEventListener('click', closeOfficialDetailModal);
    document.getElementById('official-detail-modal')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) closeOfficialDetailModal(); });
    document.getElementById('official-id-card-close')?.addEventListener('click', closeIdCardModal);
    document.getElementById('official-id-card-modal')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) closeIdCardModal(); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        setMobileMenuState(false);
        closeOfficialDetailModal();
        closeIdCardModal();
      }
    });

    document.querySelectorAll('.tab-link').forEach((btn) => btn.addEventListener('click', (event) => { event.preventDefault(); setTab(btn.dataset.tab); }));
    document.getElementById('mobile-menu-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = getNavMenu();
      setMobileMenuState(!menu?.classList.contains('active'));
    });
    document.getElementById('official-my-profile-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = getNavMenu();
      setMobileMenuState(!menu?.classList.contains('active'));
    });
    document.addEventListener('click', (e) => {
      const menu = getNavMenu();
      const toggle = getMobileToggle();
      if (!menu?.contains(e.target) && !toggle?.contains(e.target)) {
        setMobileMenuState(false);
      }
    });

    const summaryStats = () => {
      const totalStudents = allStudents.length;
      const boys = allStudents.filter((student) => normalizeText(student.gender) === 'male').length;
      const girls = allStudents.filter((student) => normalizeText(student.gender) === 'female').length;
      const classCount = new Set(allStudents.map(getStudentClass)).size;
      const teachers = allStaff.filter((staff) => staff.isActive !== false && staff.type === 'Teacher').length;
      const management = allStaff.filter((staff) => staff.isActive !== false && staff.type === 'Management').length;
      const activeStaff = allStaff.filter((staff) => staff.isActive !== false).length;
      const categoryMembers = directoryEntries.length;
      const groupCount = studentGroups.length;
      const concessionStudents = allStudents.filter(hasStudentConcession).length;
      return { totalStudents, boys, girls, classCount, teachers, management, activeStaff, categoryMembers, groupCount, concessionStudents };
    };

    const metricCard = (label, value, tone = 'blue', icon = 'fa-circle-info') => `
      <div class="official-metric-card ${tone}">
        <div><div class="official-metric-label">${escapeHtml(label)}</div><div class="official-metric-value">${escapeHtml(String(value))}</div></div>
        <i class="fas ${icon}"></i>
      </div>`;

    const evaluateModulePermissions = () => {
      const role = window.AppSession?.getRole?.() || '';
      const isStaffSession = userSession?.source === 'staff' || role === 'staff' || Boolean(window.AppSession?.getStaffAccess?.());
      const isMasterAdmin = !isStaffSession && (role === 'admin' || userSession?.source === 'firebase' || userSession?.source === 'legacy-admin' || userSession?.type === 'Admin');
      
      let canCollection = false;
      let canResult = false;
      let canWorksheet = false;
      let canAdmin = false;

      if (isMasterAdmin) {
        canCollection = true;
        canResult = true;
        canWorksheet = true;
        canAdmin = true;
      } else if (isStaffSession) {
        const staffProfile = getCurrentSessionProfile() || {};
        const staffAccess = window.AppSession?.getStaffAccess?.() || userSession?.access || {};
        canCollection = staffAccess.collection === true || (staffProfile.canCollect !== false && staffProfile.canCollect !== undefined);
        canResult = staffAccess.result === true || staffProfile.canManageResults === true;
        canWorksheet = staffAccess.worksheet !== false && staffProfile.canAccessWorksheet !== false;
        canAdmin = staffAccess.admin === true || staffAccess.canAccessAdmin === true || staffProfile.canAccessAdmin === true || staffProfile.actLikeSuperAdmin === true;
      } else if (userSession?.source === 'directory') {
        const entry = directoryEntries.find((item) => item.id === userSession.id);
        const access = getPageAccessItem(entry?.categoryId || userSession.categoryId, entry?.id || userSession.id);
        const authItem = getCategoryAuthItem(entry?.categoryId || userSession.categoryId);
        if (!access.blocked) {
          canCollection = Boolean(access.collection || (authItem.enabled && authItem.targetPage === 'collection'));
          canResult = Boolean(access.result);
          canWorksheet = true;
          canAdmin = false;
        }
      } else {
        canWorksheet = true;
      }

      return {
        collection: canCollection,
        result: canResult,
        worksheet: canWorksheet,
        admin: canAdmin
      };
    };

    const renderDashboard = () => {
      const stats = summaryStats();
      const perms = evaluateModulePermissions();
      const role = window.AppSession?.getRole?.() || '';
      const isStaffSession = userSession?.source === 'staff' || role === 'staff' || Boolean(window.AppSession?.getStaffAccess?.());
      const isMasterAdmin = !isStaffSession && (role === 'admin' || userSession?.source === 'firebase' || userSession?.source === 'legacy-admin');
      const staffProfile = isStaffSession ? getCurrentSessionProfile() : null;
      const userName = staffProfile?.name || userSession?.name || (isMasterAdmin ? 'Administrator' : 'Staff Member');
      const userRoleLabel = isMasterAdmin ? 'Super Administrator' : (staffProfile?.role || staffProfile?.type || userSession?.type || 'Staff Member');

      const modules = [
        {
          id: 'collection',
          title: 'Fee Collection',
          desc: 'Receipts, dues & billing ledger',
          icon: 'fa-hand-holding-dollar',
          iconBg: 'bg-emerald-50 text-emerald-600 border border-emerald-200',
          badgeText: 'Finance',
          hasAccess: perms.collection,
          href: 'collection.html'
        },
        {
          id: 'result',
          title: 'Result System',
          desc: 'Exams, marks & report cards',
          icon: 'fa-square-poll-vertical',
          iconBg: 'bg-blue-50 text-blue-600 border border-blue-200',
          badgeText: 'Exams',
          hasAccess: perms.result,
          href: 'result.html'
        },
        {
          id: 'worksheet',
          title: 'Worksheet Portal',
          desc: 'Registers, directory & sheets',
          icon: 'fa-file-excel',
          iconBg: 'bg-teal-50 text-teal-600 border border-teal-200',
          badgeText: 'Registers',
          hasAccess: perms.worksheet,
          href: 'worksheet.html',
          isInternalTab: false
        },
        {
          id: 'admin',
          title: 'Admin Panel',
          desc: 'Classes, staff & system control',
          icon: 'fa-sliders',
          iconBg: 'bg-indigo-50 text-indigo-600 border border-indigo-200',
          badgeText: 'Master',
          hasAccess: perms.admin,
          href: 'admin.html'
        }
      ];

      const moduleCardsHtml = modules.map((m) => {
        if (m.hasAccess) {
          const clickAction = `data-navigate-url="${m.href}"`;
          return `
            <div ${clickAction} class="group flex items-center justify-between gap-3 bg-white border border-slate-200 hover:border-blue-400 rounded-xl p-3.5 shadow-2xs hover:shadow-md transition-all duration-150 cursor-pointer">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-10 h-10 rounded-xl ${m.iconBg} flex items-center justify-center text-base shrink-0 group-hover:scale-105 transition-transform">
                  <i class="fas ${m.icon}"></i>
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    <h4 class="text-sm font-bold text-slate-900 group-hover:text-blue-600 transition-colors truncate">${m.title}</h4>
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="Available"></span>
                  </div>
                  <p class="text-[11px] text-slate-500 truncate mt-0.5">${m.desc}</p>
                </div>
              </div>
              <div class="shrink-0 flex items-center gap-1.5 pl-2">
                <span class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-slate-700 bg-slate-100 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                  <span>Open</span>
                  <i class="fas fa-chevron-right text-[9px]"></i>
                </span>
              </div>
            </div>`;
        } else {
          return `
            <div data-locked-reason="${m.title}" class="flex items-center justify-between gap-3 bg-slate-50/80 border border-slate-200/70 rounded-xl p-3.5 opacity-70 cursor-not-allowed">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-10 h-10 rounded-xl bg-slate-200/70 text-slate-400 flex items-center justify-center text-base shrink-0">
                  <i class="fas ${m.icon}"></i>
                </div>
                <div class="min-w-0">
                  <h4 class="text-sm font-bold text-slate-600 truncate">${m.title}</h4>
                  <p class="text-[11px] text-slate-400 truncate mt-0.5">${m.desc}</p>
                </div>
              </div>
              <div class="shrink-0 pl-2">
                <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold text-slate-500 bg-slate-200/70">
                  <i class="fas fa-lock text-[9px]"></i>
                  <span>Locked</span>
                </span>
              </div>
            </div>`;
        }
      }).join('');

      const dashContainer = document.getElementById('official-tab-dashboard');
      if (!dashContainer) return;

      dashContainer.innerHTML = `
        <div class="max-w-2xl mx-auto py-2 sm:py-4 space-y-3">
          <!-- Minimal Hub Welcome Strip -->
          <div class="bg-slate-900 text-white rounded-xl px-4 py-3 shadow-xs border border-slate-800 flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="text-[10px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                <i class="fas fa-shield-alt"></i>
                <span class="truncate">${escapeHtml(resolveInstitutionName(institutionConfig) || 'Institution')} Hub</span>
              </div>
              <h3 class="text-sm sm:text-base font-bold text-white truncate mt-0.5">Welcome, ${escapeHtml(userName)}</h3>
            </div>
            <span class="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-white/10 text-slate-200 border border-white/10">
              ${escapeHtml(userRoleLabel)}
            </span>
          </div>

          <!-- Compact 4-Portal Access Grid -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            ${moduleCardsHtml}
          </div>
        </div>`;

      // Event bindings
      document.querySelectorAll('[data-open-tab]').forEach((btn) => {
        btn.addEventListener('click', () => setTab(btn.dataset.openTab));
      });
      document.querySelectorAll('[data-navigate-url]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const url = btn.dataset.navigateUrl;
          if (url) window.location.href = url;
        });
      });
      document.querySelectorAll('[data-locked-reason]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const modTitle = btn.dataset.lockedReason || 'This module';
          openOfficialDetailModal(
            'Access Restricted',
            `<div class="text-center py-6 px-4">
              <div class="w-14 h-14 rounded-2xl bg-slate-100 text-slate-400 mx-auto flex items-center justify-center text-2xl mb-4 border border-slate-200">
                <i class="fas fa-lock"></i>
              </div>
              <h3 class="text-lg font-extrabold text-slate-900 mb-1">${escapeHtml(modTitle)} is Locked</h3>
              <p class="text-sm text-slate-600 max-w-sm mx-auto leading-relaxed">Your current staff account has not been granted permissions for this department.</p>
              <div class="mt-4 p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-500 font-medium max-w-sm mx-auto text-left">
                <b class="text-slate-700">Need Access?</b> Please contact the institution administrator to enable this permission on your staff account profile.
              </div>
              <div class="mt-6 flex justify-center">
                <button type="button" onclick="document.getElementById('official-detail-close')?.click()" class="px-5 py-2.5 rounded-xl text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 transition-all">
                  Understood
                </button>
              </div>
            </div>`
          );
        });
      });
      document.getElementById('hub-quick-logout')?.addEventListener('click', () => {
        localStorage.removeItem(OFFICIAL_SESSION_KEY);
        window.AppSession?.clearAll?.();
        window.location.href = 'index.html';
      });
    };

    const buildStudentDetailHtml = (student = {}) => {
      const prof = (student?.profile && typeof student.profile === 'object') ? student.profile : {};
      const pick = (...vals) => {
        for (const v of vals) {
          if (v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim() !== '--') {
            return String(v).trim();
          }
        }
        return '';
      };


      const group = getStudentGroup(student.id);
      const status = getStudentStatus(student);
      const isAct = status.toLowerCase() === 'active';

      const nameVal = pick(student.name, prof.name) || '--';
      const classVal = pick(student.class, student.studentClass, prof.class) || '--';
      const admVal = pick(student.adm, prof.admNo, prof.adm) || '--';
      const uidVal = pick(student.uid, prof.uid) || '--';
      const genderVal = pick(student.gender, prof.gender) || '--';
      const fatherVal = pick(student.father, prof.father, student.guardian) || '--';
      const motherVal = pick(student.mother, prof.mother) || '--';
      const dobVal = formatDateIfIso(pick(student.dob, prof.dob));
      const admDateVal = formatDateIfIso(pick(student.adm_date, student.admDate, prof.admDate, prof.adm_date));
      const adhaarVal = pick(student.adhaar, student.aadhaar, student.aadhar, prof.adhaar, prof.aadhaar) || '--';
      const fatherPhone = pick(student.mobile, student.phone, student.fatherMobile, prof.mobile, prof.phone);
      const motherPhone = pick(student.motherMobile, student.mother_mobile, prof.motherMobile);
      const addressVal = pick(student.address, prof.address) || '--';

      const hasIndividualConc = hasStudentConcession(student);
      const concText = group
        ? (hasIndividualConc ? `₹${student.concessionFee}/month (Group: ₹${group.fee || 0}/month)` : `Group Standard Rate: ₹${group.fee || 0}/month`)
        : (hasIndividualConc ? `₹${student.concessionFee}/month` : 'Standard Rate (No Concession)');

      const avatarHtml = renderAvatarMarkup(student, nameVal, 'w-14 h-14 sm:w-22 sm:h-22 rounded-xl sm:rounded-2xl text-xl sm:text-2xl shadow-md border-2 border-white/30 shrink-0');

      return `
        <div class="space-y-2.5 sm:space-y-4">
          <!-- Top Identity Header Banner -->
          <div class="flex items-center gap-3 sm:gap-4 p-3 sm:p-5 rounded-xl sm:rounded-2xl bg-gradient-to-br from-slate-900 via-indigo-950 to-blue-950 text-white shadow-xl border border-slate-800">
            <div class="relative shrink-0">
              ${avatarHtml}
              <span class="absolute -bottom-1 -right-1 w-4 h-4 sm:w-5 sm:h-5 rounded-full border-2 border-slate-900 ${isAct ? 'bg-emerald-500' : 'bg-rose-500'} flex items-center justify-center text-[8px] sm:text-[9px]" title="${isAct ? 'Active Student' : 'Inactive'}">
                <i class="fas ${isAct ? 'fa-check' : 'fa-times'} text-white"></i>
              </span>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex flex-wrap items-center gap-1.5 mb-1">
                <span class="px-2 py-0.5 rounded-full text-[10px] sm:text-[11px] font-extrabold uppercase tracking-wider ${isAct ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30' : 'bg-rose-500/20 text-rose-300 border border-rose-400/30'}">
                  <i class="fas fa-circle text-[6px] mr-1"></i>${escapeHtml(status)}
                </span>
                <span class="px-2 py-0.5 rounded-lg text-[10px] sm:text-[11px] font-extrabold bg-blue-600 text-white shadow-xs">
                  <i class="fas fa-graduation-cap mr-1 opacity-80"></i>Class ${escapeHtml(classVal)}
                </span>
                <span class="px-2 py-0.5 rounded-lg text-[10px] sm:text-[11px] font-mono font-bold bg-white/10 text-slate-100 border border-white/15">
                  Adm: ${escapeHtml(admVal)}
                </span>
              </div>
              <h3 class="text-base sm:text-2xl font-black text-white leading-tight truncate sm:whitespace-normal">${escapeHtml(nameVal)}</h3>
              <div class="text-[11px] sm:text-xs font-semibold text-indigo-200 mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                <span><i class="fas fa-venus-mars mr-1 opacity-75"></i>${escapeHtml(genderVal)}</span>
                <span class="opacity-50">•</span>
                <span><i class="fas fa-fingerprint mr-1 opacity-75"></i>UID: <b class="text-white font-mono">${escapeHtml(uidVal)}</b></span>
                <span class="opacity-50">•</span>
                <span><i class="fas fa-calendar-alt mr-1 opacity-75"></i>DOB: <b class="text-white font-mono">${escapeHtml(dobVal)}</b></span>
              </div>
            </div>
          </div>

          <!-- Section 1: Academic & Enrollment Information -->
          <div class="bg-white rounded-xl sm:rounded-2xl border border-slate-200 shadow-xs p-2.5 sm:p-4">
            <h4 class="text-[11px] sm:text-xs font-extrabold uppercase tracking-wider text-slate-500 mb-2 sm:mb-3 flex items-center gap-1.5">
              <i class="fas fa-id-card text-blue-600"></i>
              <span>Academic & Enrollment Information</span>
            </h4>
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 text-xs">
              <div class="p-2 sm:p-3 rounded-lg sm:rounded-xl bg-slate-50 border border-slate-200/80">
                <span class="text-[9px] sm:text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Class / Division</span>
                <span class="text-xs sm:text-sm font-extrabold text-indigo-950 mt-0.5 block truncate">${escapeHtml(classVal)}</span>
              </div>
              <div class="p-2 sm:p-3 rounded-lg sm:rounded-xl bg-slate-50 border border-slate-200/80">
                <span class="text-[9px] sm:text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Admission Number</span>
                <span class="text-xs sm:text-sm font-extrabold font-mono text-slate-900 mt-0.5 block truncate">${escapeHtml(admVal)}</span>
              </div>
              <div class="p-2 sm:p-3 rounded-lg sm:rounded-xl bg-slate-50 border border-slate-200/80">
                <span class="text-[9px] sm:text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Date of Admission</span>
                <span class="text-xs sm:text-sm font-extrabold font-mono text-slate-900 mt-0.5 block truncate">${escapeHtml(admDateVal)}</span>
              </div>
              <div class="p-2 sm:p-3 rounded-lg sm:rounded-xl bg-slate-50 border border-slate-200/80">
                <span class="text-[9px] sm:text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Unique ID (UID)</span>
                <span class="text-xs sm:text-sm font-extrabold font-mono text-slate-900 mt-0.5 block truncate">${escapeHtml(uidVal)}</span>
              </div>
            </div>
          </div>

          <!-- Section 2: Personal Details -->
          <div class="bg-white rounded-xl sm:rounded-2xl border border-slate-200 shadow-xs p-2.5 sm:p-4">
            <h4 class="text-[11px] sm:text-xs font-extrabold uppercase tracking-wider text-slate-500 mb-2 sm:mb-3 flex items-center gap-1.5">
              <i class="fas fa-user text-indigo-600"></i>
              <span>Personal Details</span>
            </h4>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3 text-xs">
              <div class="p-2 sm:p-3 rounded-lg sm:rounded-xl bg-slate-50 border border-slate-200/80">
                <span class="text-[9px] sm:text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Gender</span>
                <span class="text-xs sm:text-sm font-extrabold text-slate-900 mt-0.5 block flex items-center gap-1 truncate">
                  <i class="fas ${genderVal.toLowerCase() === 'female' ? 'fa-female text-pink-500' : 'fa-male text-blue-500'}"></i>
                  ${escapeHtml(genderVal)}
                </span>
              </div>
              <div class="p-2 sm:p-3 rounded-lg sm:rounded-xl bg-slate-50 border border-slate-200/80">
                <span class="text-[9px] sm:text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Date of Birth (DOB)</span>
                <span class="text-xs sm:text-sm font-extrabold font-mono text-slate-900 mt-0.5 block truncate">${escapeHtml(dobVal)}</span>
              </div>
              <div class="p-2 sm:p-3 rounded-lg sm:rounded-xl bg-slate-50 border border-slate-200/80 col-span-2 sm:col-span-1">
                <span class="text-[9px] sm:text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Aadhaar Number</span>
                <span class="text-xs sm:text-sm font-extrabold font-mono text-slate-900 mt-0.5 block truncate">${escapeHtml(adhaarVal)}</span>
              </div>
            </div>
          </div>

          <!-- Section 3: Parent, Contact & Address -->
          <div class="bg-white rounded-xl sm:rounded-2xl border border-slate-200 shadow-xs p-2.5 sm:p-4">
            <h4 class="text-[11px] sm:text-xs font-extrabold uppercase tracking-wider text-slate-500 mb-2 sm:mb-3 flex items-center gap-1.5">
              <i class="fas fa-phone-alt text-emerald-600"></i>
              <span>Parent, Contact & Address</span>
            </h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3 text-xs mb-2 sm:mb-3">
              <div class="p-2 sm:p-3 rounded-lg sm:rounded-xl bg-slate-50 border border-slate-200/80">
                <div class="flex items-center justify-between gap-1">
                  <span class="text-[9px] sm:text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">Father's Info</span>
                  ${fatherPhone ? `<a href="tel:${escapeHtml(fatherPhone)}" class="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold inline-flex items-center gap-1 shrink-0 transition shadow-2xs"><i class="fas fa-phone-alt text-[8px]"></i> Call</a>` : ''}
                </div>
                <div class="text-xs sm:text-sm font-extrabold text-slate-900 mt-1 truncate">${escapeHtml(fatherVal)}</div>
                <div class="font-bold font-mono text-[11px] sm:text-xs text-slate-600 mt-0.5">${escapeHtml(fatherPhone || 'No Phone')}</div>
              </div>
              <div class="p-2 sm:p-3 rounded-lg sm:rounded-xl bg-slate-50 border border-slate-200/80">
                <div class="flex items-center justify-between gap-1">
                  <span class="text-[9px] sm:text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">Mother's Info</span>
                  ${motherPhone ? `<a href="tel:${escapeHtml(motherPhone)}" class="px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold inline-flex items-center gap-1 shrink-0 transition shadow-2xs"><i class="fas fa-phone-alt text-[8px]"></i> Call</a>` : ''}
                </div>
                <div class="text-xs sm:text-sm font-extrabold text-slate-900 mt-1 truncate">${escapeHtml(motherVal)}</div>
                <div class="font-bold font-mono text-[11px] sm:text-xs text-slate-600 mt-0.5">${escapeHtml(motherPhone || 'No Phone')}</div>
              </div>
            </div>
            <div class="p-2 sm:p-3 rounded-lg sm:rounded-xl bg-slate-50 border border-slate-200/80 text-xs">
              <span class="text-[9px] sm:text-[10px] font-extrabold text-slate-400 uppercase tracking-wider block">Permanent Address</span>
              <div class="text-xs sm:text-sm font-bold text-slate-800 mt-1 leading-snug break-words flex items-start gap-1.5">
                <i class="fas fa-map-marker-alt text-slate-400 mt-0.5 shrink-0 text-xs"></i>
                <span>${escapeHtml(addressVal)}</span>
              </div>
            </div>
          </div>

          <!-- Section 4: Fees, Concession & Sibling Group -->
          <div class="grid grid-cols-1 ${group ? 'lg:grid-cols-2' : ''} gap-2 sm:gap-3">
            <div class="bg-white rounded-xl sm:rounded-2xl border ${hasIndividualConc || group ? 'border-emerald-200 bg-emerald-50/30' : 'border-slate-200'} p-2.5 sm:p-4 shadow-xs">
              <h4 class="text-[11px] sm:text-xs font-extrabold uppercase tracking-wider ${hasIndividualConc || group ? 'text-emerald-800' : 'text-slate-500'} mb-1.5 sm:mb-2 flex items-center gap-1.5">
                <i class="fas fa-receipt text-emerald-600"></i>
                <span>Fee Concession Status</span>
              </h4>
              <div class="p-2 sm:p-3 rounded-lg sm:rounded-xl ${hasIndividualConc || group ? 'bg-emerald-50 border border-emerald-200' : 'bg-slate-50 border border-slate-200'}">
                <div class="text-xs sm:text-sm font-extrabold ${hasIndividualConc || group ? 'text-emerald-950' : 'text-slate-800'}">${escapeHtml(concText)}</div>
                ${hasIndividualConc ? `<p class="text-[10px] sm:text-[11px] font-semibold text-emerald-700 mt-0.5">Special individualized fee rate active for this student.</p>` : ''}
              </div>
            </div>

            ${group ? `
              <div class="bg-white rounded-xl sm:rounded-2xl border border-blue-200 bg-blue-50/30 p-2.5 sm:p-4 shadow-xs">
                <div class="flex items-center justify-between gap-1.5 mb-2">
                  <h4 class="text-[11px] sm:text-xs font-extrabold uppercase tracking-wider text-blue-900 flex items-center gap-1.5">
                    <i class="fas fa-users text-blue-600"></i>
                    <span>Family / Sibling Group</span>
                  </h4>
                  <span class="text-[10px] sm:text-[11px] font-extrabold text-blue-900 bg-white border border-blue-200 px-2 py-0.5 rounded-full shadow-2xs">Fee: ₹${escapeHtml(String(group.fee || 0))}/mo</span>
                </div>
                <div class="space-y-1.5">
                  ${getGroupMemberRows(group).map((member, index) => {
                    const isCurrent = member.id === student.id;
                    return `
                      <div class="flex items-center justify-between gap-2 rounded-lg sm:rounded-xl bg-white border ${isCurrent ? 'border-blue-400 bg-blue-50/60 font-black' : 'border-blue-100'} px-2.5 py-1.5 sm:px-3 sm:py-2 text-xs shadow-2xs">
                        <span class="${isCurrent ? 'font-extrabold text-blue-950' : 'font-bold text-slate-800'} truncate">${index + 1}. ${escapeHtml(member.name || '--')} ${isCurrent ? '(This Student)' : ''}</span>
                        <div class="flex items-center gap-1.5 shrink-0">
                          <span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[9px] sm:text-[10px] font-bold">Adm: ${escapeHtml(member.adm || '--')}</span>
                          <span class="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-bold text-[9px] sm:text-[10px]">Cls: ${escapeHtml(member.class || '--')}</span>
                        </div>
                      </div>`;
                  }).join('')}
                </div>
              </div>` : ''}
          </div>

          ${(student.busStop || student.busFee || student.route) ? `
            <div class="p-2.5 sm:p-3.5 rounded-xl sm:rounded-2xl border border-amber-200 bg-amber-50/80 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div class="font-extrabold text-amber-800 uppercase tracking-wider text-[10px] sm:text-[11px] flex items-center gap-1.5">
                <i class="fas fa-bus text-amber-600"></i> Transport & Bus Service
              </div>
              <div class="font-bold text-slate-900 text-[11px] sm:text-xs">
                Stop: <b>${escapeHtml(student.busStop || '--')}</b> &nbsp;•&nbsp; Bus Fee: <b>₹${escapeHtml(String(student.busFee || 0))}</b> &nbsp;•&nbsp; Route: <b>${escapeHtml(student.route || '--')}</b>
              </div>
            </div>` : ''}
        </div>`;
    };

    const attachStudentModalTabs = () => {};

    const getFilteredStudentsList = () => {
      const yearStudents = getStudentsForCurrentAcademicYear();
      return yearStudents
        .filter((student) => {
          const cls = getStudentClass(student);
          const gender = normalizeText(student.gender);
          const status = normalizeText(getStudentStatus(student));
          const searchable = Object.entries(student || {})
            .filter(([k]) => k !== 'photo' && k !== 'image' && k !== 'academicYears')
            .map(([, v]) => valueToDisplay(v))
            .join(' ')
            .toLowerCase();
          const group = getStudentGroup(student.id);
          const classOk = !officialFilters.studentClass || officialFilters.studentClass === 'ALL' || cls === officialFilters.studentClass;
          const genderOk = officialFilters.studentGender === 'ALL' || gender === normalizeText(officialFilters.studentGender);
          const statusOk = officialFilters.studentStatus === 'ALL' || status === normalizeText(officialFilters.studentStatus);
          const searchOk = !officialFilters.studentSearch || searchable.includes(officialFilters.studentSearch.toLowerCase());
          const infoOk = officialFilters.studentInfo === 'ALL'
            || (officialFilters.studentInfo === 'GROUPED' && Boolean(group))
            || (officialFilters.studentInfo === 'CONCESSION' && hasStudentConcession(student))
            || (officialFilters.studentInfo === 'MISSING_MOBILE' && !student.mobile)
            || (officialFilters.studentInfo === 'MISSING_UID' && !student.uid);
          return classOk && genderOk && statusOk && searchOk && infoOk;
        })
        .sort((a, b) => getStudentClass(a).localeCompare(getStudentClass(b), undefined, { numeric: true }) || String(a.name || '').localeCompare(String(b.name || '')));
    };

    const exportStudentsToExcel = (studentsToExport = []) => {
      if (typeof XLSX === 'undefined') {
        openOfficialDetailModal('Export Notice', '<p class="text-sm text-slate-600 p-4">Excel library is still loading. Please try again in a moment.</p>');
        return;
      }
      const rowsData = studentsToExport.map((s, idx) => {
        const grp = getStudentGroup(s.id);
        return {
          'No': idx + 1,
          'Class': s.class || '',
          'UID / Roll No': s.uid || '',
          'Student Name': s.name || '',
          'Father Name': s.father || '',
          'Mother Name': s.mother || '',
          'Gender': s.gender || '',
          'Adm No': s.adm || '',
          'Date of Birth': s.dob || '',
          'Admission Date': s.adm_date || s.admDate || '',
          'Status': getStudentStatus(s),
          'Aadhaar No': s.adhaar || s.aadhaar || s.aadhar || '',
          'Father Mobile': s.mobile || s.phone || '',
          'Mother Mobile': s.motherMobile || s.mother_mobile || '',
          'Concession Fee': hasStudentConcession(s) ? s.concessionFee : '',
          'Group Info': grp ? `Group (${grp.fee || 0})` : '',
          'Address': s.address || ''
        };
      });
      const ws = XLSX.utils.json_to_sheet(rowsData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Students Register');
      const yearLabel = officialFilters.academicYearId || activeAcademicYearId || 'Current';
      const classLabel = officialFilters.studentClass && officialFilters.studentClass !== 'ALL' ? `Class_${officialFilters.studentClass}` : 'All_Classes';
      XLSX.writeFile(wb, `Students_Register_${yearLabel}_${classLabel}.xlsx`);
    };

    const printStudentsRegisterPdf = (studentsToPrint = []) => {
      const instName = resolveInstitutionName(institutionConfig) || 'Institution Official Portal';
      const yearObj = academicYears.find((y) => y.id === (officialFilters.academicYearId || activeAcademicYearId));
      const yearTitle = yearObj ? (yearObj.name || yearObj.id) : (officialFilters.academicYearId || activeAcademicYearId || 'Current Academic Year');
      const classTitle = (!officialFilters.studentClass || officialFilters.studentClass === 'ALL') ? 'All Classes' : `Class ${officialFilters.studentClass}`;

      let printContainer = document.getElementById('students-register-print-area');
      if (!printContainer) {
        printContainer = document.createElement('div');
        printContainer.id = 'students-register-print-area';
        printContainer.className = 'hidden';
        document.body.appendChild(printContainer);
      }

      printContainer.innerHTML = `
        <div class="p-4 bg-white text-slate-900">
          <div class="text-center border-b-2 border-slate-800 pb-3 mb-4">
            <h1 class="text-xl font-black uppercase">${escapeHtml(instName)}</h1>
            <p class="text-xs font-bold text-slate-600 mt-0.5">Students Register • Academic Year: ${escapeHtml(yearTitle)} • ${escapeHtml(classTitle)} (${studentsToPrint.length} Students)</p>
          </div>
          <table class="w-full text-[10px] border-collapse border border-slate-400">
            <thead>
              <tr class="bg-slate-100">
                <th class="border border-slate-400 p-1">No</th>
                <th class="border border-slate-400 p-1">Class</th>
                <th class="border border-slate-400 p-1">UID</th>
                <th class="border border-slate-400 p-1 text-left">Student Name</th>
                <th class="border border-slate-400 p-1 text-left">Father Name</th>
                <th class="border border-slate-400 p-1 text-left">Mother Name</th>
                <th class="border border-slate-400 p-1">Gender</th>
                <th class="border border-slate-400 p-1">Adm No</th>
                <th class="border border-slate-400 p-1">DOB</th>
                <th class="border border-slate-400 p-1">Adm Date</th>
                <th class="border border-slate-400 p-1">Status</th>
                <th class="border border-slate-400 p-1">Aadhaar</th>
                <th class="border border-slate-400 p-1">Father Phone</th>
                <th class="border border-slate-400 p-1">Mother Phone</th>
                <th class="border border-slate-400 p-1 text-left">Address</th>
              </tr>
            </thead>
            <tbody>
              ${studentsToPrint.map((s, idx) => `
                <tr>
                  <td class="border border-slate-400 p-1 text-center font-bold">${idx + 1}</td>
                  <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.class || '--')}</td>
                  <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.uid || '--')}</td>
                  <td class="border border-slate-400 p-1 font-bold">${escapeHtml(s.name || '--')}</td>
                  <td class="border border-slate-400 p-1">${escapeHtml(s.father || '--')}</td>
                  <td class="border border-slate-400 p-1">${escapeHtml(s.mother || '--')}</td>
                  <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.gender || '--')}</td>
                  <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.adm || '--')}</td>
                  <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.dob || '--')}</td>
                  <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.adm_date || s.admDate || '--')}</td>
                  <td class="border border-slate-400 p-1 text-center">${escapeHtml(getStudentStatus(s))}</td>
                  <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.adhaar || s.aadhaar || s.aadhar || '--')}</td>
                  <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.mobile || s.phone || '--')}</td>
                  <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.motherMobile || s.mother_mobile || '--')}</td>
                  <td class="border border-slate-400 p-1">${escapeHtml(s.address || '--')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

      const styleEl = document.createElement('style');
      styleEl.id = 'students-register-print-style';
      styleEl.textContent = `
        @media print {
          body.printing-students-register > *:not(#students-register-print-area) { display: none !important; }
          body.printing-students-register #students-register-print-area { display: block !important; position: static !important; width: 100% !important; }
        }
      `;
      document.head.appendChild(styleEl);
      document.body.classList.add('printing-students-register');
      window.print();
      setTimeout(() => {
        document.body.classList.remove('printing-students-register');
        styleEl.remove();
      }, 600);
    };

    const renderStudents = () => {
      const yearStudents = getStudentsForCurrentAcademicYear();
      const classOptions = [...new Set(yearStudents.map(getStudentClass))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const filteredStudents = getFilteredStudentsList();

      const totalCount = filteredStudents.length;
      const pageSize = officialFilters.studentPageSize === 0 ? Math.max(1, totalCount) : Number(officialFilters.studentPageSize || 25);
      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
      if (officialFilters.studentPage > totalPages) officialFilters.studentPage = totalPages;
      if (officialFilters.studentPage < 1) officialFilters.studentPage = 1;

      const startIdx = totalCount === 0 ? 0 : (officialFilters.studentPage - 1) * pageSize;
      const endIdx = totalCount === 0 ? 0 : Math.min(startIdx + pageSize, totalCount);
      const paginatedStudents = filteredStudents.slice(startIdx, endIdx);

      const coreAdminColumns = [
        { key: 'name', label: 'Student Name' },
        { key: 'class', label: 'Class' },
        { key: 'uid', label: 'UID' },
        { key: 'father', label: 'Father Name' },
        { key: 'mother', label: 'Mother Name' },
        { key: 'gender', label: 'Gender' },
        { key: 'adm', label: 'Adm No' },
        { key: 'dob', label: 'DOB' },
        { key: 'adm_date', label: 'Admission Date' },
        { key: 'status', label: 'Status' },
        { key: 'adhaar', label: 'Aadhaar No' },
        { key: 'mobile', label: 'Father Mobile' },
        { key: 'motherMobile', label: 'Mother Mobile' },
        { key: 'address', label: 'Permanent Address' },
        { key: 'group', label: 'Group' },
        { key: 'concessionFee', label: 'Concession' }
      ];

      const headerCells = coreAdminColumns.map((col) =>
        `<th class="${col.key === 'name' ? 'stu-sticky-col-3' : ''} px-2.5 py-2.5 whitespace-nowrap text-left font-extrabold text-slate-700">${escapeHtml(col.label)}</th>`
      ).join('');

      const getStudentColValue = (student, key) => {
        const prof = (student?.profile && typeof student.profile === 'object') ? student.profile : {};
        if (key === 'status') return getStudentStatus(student);
        if (key === 'adm') return student.adm || prof.admNo || prof.adm || '--';
        if (key === 'uid') return student.uid || prof.uid || '--';
        if (key === 'father') return student.father || prof.father || student.guardian || '--';
        if (key === 'mother') return student.mother || prof.mother || '--';
        if (key === 'gender') return student.gender || prof.gender || '--';
        if (key === 'dob') return formatDateIfIso(student.dob || prof.dob || '');
        if (key === 'adm_date') return formatDateIfIso(student.adm_date || student.admDate || prof.admDate || prof.adm_date || '');
        if (key === 'adhaar') return student.adhaar || student.aadhaar || student.aadhar || prof.adhaar || prof.aadhaar || '--';
        if (key === 'mobile') return student.mobile || student.phone || student.fatherMobile || prof.mobile || prof.phone || '--';
        if (key === 'motherMobile') return student.motherMobile || student.mother_mobile || prof.motherMobile || '--';
        if (key === 'address') return student.address || prof.address || '--';
        if (key === 'group') {
          const grp = getStudentGroup(student.id);
          return grp ? `Group ₹${grp.fee || 0}` : '--';
        }
        if (key === 'concessionFee') return hasStudentConcession(student) ? `₹${student.concessionFee}` : '--';
        const val = valueToDisplay(student?.[key] !== undefined ? student[key] : prof?.[key]);
        return val !== '' ? val : '--';
      };

      const rows = paginatedStudents.map((student, idx) => {
        const serialNo = startIdx + idx + 1;
        const group = getStudentGroup(student.id);
        const status = getStudentStatus(student);
        return `<tr class="hover:bg-blue-50/80 cursor-pointer official-student-row transition-colors odd:bg-white even:bg-slate-50/40" data-student-id="${escapeHtml(student.id)}">
          <td class="stu-sticky-col-1 px-2.5 py-2 text-center font-extrabold text-slate-700">${serialNo}</td>
          <td class="stu-sticky-col-2 px-2 py-1.5 text-center align-middle">
            ${renderAvatarMarkup(student, student.name, 'w-9 h-9 rounded-xl text-xs')}
          </td>
          ${coreAdminColumns.map((col) => {
            const val = getStudentColValue(student, col.key);
            if (col.key === 'name') {
              return `<td class="stu-sticky-col-3 px-2.5 py-2 align-middle font-extrabold text-slate-900 whitespace-nowrap truncate" title="${escapeHtml(val)}">${escapeHtml(val)}</td>`;
            }
            if (col.key === 'class') {
              return `<td class="px-2.5 py-2 align-middle text-center whitespace-nowrap"><span class="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 font-bold text-xs">Class ${escapeHtml(val)}</span></td>`;
            }
            if (col.key === 'status') {
              return `<td class="px-2.5 py-2 align-middle text-center whitespace-nowrap"><span class="px-2 py-0.5 rounded-full text-[11px] font-bold ${status === 'Active' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}">${escapeHtml(status)}</span></td>`;
            }
            if (col.key === 'group') {
              return `<td class="px-2.5 py-2 align-middle whitespace-nowrap text-center">${group ? `<span class="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 font-bold text-xs border border-blue-200">Group ₹${escapeHtml(String(group.fee || 0))}</span>` : '<span class="text-slate-400">--</span>'}</td>`;
            }
            if (col.key === 'concessionFee') {
              return `<td class="px-2.5 py-2 align-middle whitespace-nowrap text-center">${hasStudentConcession(student) ? `<span class="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 font-bold text-xs border border-emerald-200">₹${escapeHtml(String(student.concessionFee))}</span>` : '<span class="text-slate-400">--</span>'}</td>`;
            }
            if (col.key === 'address') {
              return `<td class="px-2.5 py-2 align-middle min-w-[180px] max-w-[260px] truncate text-slate-700" title="${escapeHtml(val)}">${escapeHtml(val)}</td>`;
            }
            return `<td class="px-2.5 py-2 align-middle whitespace-nowrap text-slate-700">${escapeHtml(val)}</td>`;
          }).join('')}
        </tr>`;
      }).join('');

      const cardRows = paginatedStudents.map((student, idx) => {
        const serialNo = startIdx + idx + 1;
        const group = getStudentGroup(student.id);
        const status = getStudentStatus(student);
        const isAct = status.toLowerCase() === 'active';
        const prof = (student?.profile && typeof student.profile === 'object') ? student.profile : {};
        const fatherPhone = student.mobile || student.phone || student.fatherMobile || prof.mobile || prof.phone || '';
        const motherPhone = student.motherMobile || student.mother_mobile || prof.motherMobile || '';
        const hasConc = hasStudentConcession(student);
        const dobFormatted = formatDateIfIso(student.dob || prof.dob || '');
        const admDateFormatted = formatDateIfIso(student.adm_date || student.admDate || prof.admDate || prof.adm_date || '');
        return `
          <div class="official-student-card p-3.5 text-left w-full border border-slate-200 bg-white rounded-2xl shadow-xs hover:border-blue-400 hover:shadow-md transition-all cursor-pointer" data-student-id="${escapeHtml(student.id)}">
            <div class="flex items-start gap-3 w-full">
              <span class="w-6 text-center font-extrabold text-xs text-slate-400 mt-1">${serialNo}</span>
              ${renderAvatarMarkup(student, student.name, 'w-12 h-12 rounded-xl text-sm shrink-0 border border-slate-200 shadow-2xs')}
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-1.5 mb-1">
                  <span class="font-extrabold text-slate-900 text-sm truncate">${escapeHtml(student.name || '--')}</span>
                  <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${isAct ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'} whitespace-nowrap">${escapeHtml(status)}</span>
                </div>
                <div class="flex flex-wrap items-center gap-1.5 mb-2 text-xs">
                  <span class="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 font-bold text-[11px]">Class ${escapeHtml(student.class || '--')}</span>
                  <span class="text-slate-500 font-medium">Adm: <b class="text-slate-800 font-mono">${escapeHtml(student.adm || prof.admNo || '--')}</b></span>
                  <span class="text-slate-400">•</span>
                  <span class="text-slate-500 font-medium">UID: <b class="text-slate-800 font-mono">${escapeHtml(student.uid || prof.uid || '--')}</b></span>
                </div>
                <div class="space-y-1 text-[11px] text-slate-600 bg-slate-50/80 p-2.5 rounded-xl border border-slate-100 mb-2">
                  <div class="flex items-center justify-between gap-1">
                    <span class="truncate">Father: <b class="text-slate-800">${escapeHtml(student.father || prof.father || '--')}</b></span>
                    ${fatherPhone ? `<a href="tel:${escapeHtml(fatherPhone)}" onclick="event.stopPropagation()" class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px] hover:bg-emerald-200 inline-flex items-center gap-1 shrink-0"><i class="fas fa-phone-alt text-[8px]"></i> Call</a>` : ''}
                  </div>
                  ${fatherPhone ? `<div class="text-[10px] text-slate-500">Father Mobile: <b class="text-slate-700 font-mono">${escapeHtml(fatherPhone)}</b></div>` : ''}
                  ${motherPhone ? `<div class="text-[10px] text-slate-500">Mother Mobile: <b class="text-slate-700 font-mono">${escapeHtml(motherPhone)}</b></div>` : ''}
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-500 pt-1 border-t border-slate-200/50">
                    <span>DOB: <b class="text-slate-700 font-mono">${escapeHtml(dobFormatted || '--')}</b></span>
                    <span>•</span>
                    <span>Adm Date: <b class="text-slate-700 font-mono">${escapeHtml(admDateFormatted || '--')}</b></span>
                  </div>
                </div>
                <div class="flex flex-wrap items-center justify-between gap-1.5 pt-1 border-t border-slate-100 text-[11px]">
                  <div class="flex flex-wrap items-center gap-1.5">
                    ${group ? `<span class="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-bold border border-blue-200 text-[10px]">Group ₹${escapeHtml(String(group.fee || 0))}</span>` : ''}
                    ${hasConc ? `<span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-bold border border-emerald-200 text-[10px]">Conc: ₹${escapeHtml(String(student.concessionFee))}</span>` : ''}
                  </div>
                  <span class="text-blue-600 font-bold inline-flex items-center gap-1 hover:underline text-xs">View Profile <i class="fas fa-chevron-right text-[10px]"></i></span>
                </div>
              </div>
            </div>
          </div>`;
      }).join('');

      const stuTarget = document.getElementById('official-tab-students');
      if (!stuTarget) return;

      const selectedYearValue = officialFilters.academicYearId || activeAcademicYearId || '';
      const yearOptionsHtml = academicYears.length
        ? academicYears.map((y) => `<option value="${escapeHtml(y.id)}" ${selectedYearValue === y.id ? 'selected' : ''}>Academic Year: ${escapeHtml(y.name || y.id)}${y.id === activeAcademicYearId ? ' (Active)' : ''}</option>`).join('')
        : `<option value="">Current Academic Year</option>`;

      const emptyStudentMessage = 'No student records match the selected filters.';

      stuTarget.innerHTML = `
        <div class="card p-3 sm:p-5 rounded-2xl shadow-sm w-full max-w-none">
          <!-- Top Header & Export Buttons -->
          <div class="flex items-center justify-between gap-2 sm:gap-3 mb-3 pb-2.5 border-b border-slate-100">
            <div>
              <h3 class="font-extrabold text-base sm:text-lg text-slate-900 flex items-center gap-1.5 sm:gap-2">
                <i class="fas fa-user-graduate text-blue-600"></i>
                <span>Students Register</span>
                <span class="text-[11px] sm:text-xs font-extrabold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">${totalCount}</span>
              </h3>
              <p class="text-[11px] sm:text-xs text-slate-500 font-semibold mt-0.5 hidden sm:block">Complete admin-entered student details with Academic Year filter, pagination, and Excel/PDF export.</p>
            </div>
            <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
              <button type="button" id="btn-students-export-pdf" class="inline-flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-1.5 sm:py-2 rounded-lg sm:rounded-xl text-[11px] sm:text-xs font-extrabold text-white bg-rose-600 hover:bg-rose-700 shadow-xs transition-all cursor-pointer">
                <i class="fas fa-file-pdf"></i>
                <span>PDF<span class="hidden sm:inline"> / Print</span></span>
              </button>
              <button type="button" id="btn-students-export-excel" class="inline-flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-1.5 sm:py-2 rounded-lg sm:rounded-xl text-[11px] sm:text-xs font-extrabold text-white bg-emerald-600 hover:bg-emerald-700 shadow-xs transition-all cursor-pointer">
                <i class="fas fa-file-excel"></i>
                <span><span class="hidden sm:inline">Export </span>Excel</span>
              </button>
            </div>
          </div>

          <!-- Clearly Visible Filter Input Controls (2-column compact grid on mobile) -->
          <div class="grid grid-cols-2 lg:grid-cols-6 gap-2 mb-3 bg-slate-50/80 p-2 sm:p-3 rounded-xl sm:rounded-2xl border border-slate-200/80">
            <div>
              <label class="block text-[9px] sm:text-[10px] font-extrabold uppercase tracking-wider text-slate-500 mb-0.5 sm:mb-1">Academic Year</label>
              <select id="official-student-year" class="w-full py-1.5 sm:py-2 px-2 sm:px-2.5 rounded-lg sm:rounded-xl border border-slate-300 bg-white text-xs font-bold text-slate-800 shadow-2xs focus:border-blue-500">
                ${yearOptionsHtml}
              </select>
            </div>
            <div>
              <label class="block text-[9px] sm:text-[10px] font-extrabold uppercase tracking-wider text-slate-500 mb-0.5 sm:mb-1">Class</label>
              <select id="official-student-class" class="w-full py-1.5 sm:py-2 px-2 sm:px-2.5 rounded-lg sm:rounded-xl border border-slate-300 bg-white text-xs font-bold text-slate-800 shadow-2xs focus:border-blue-500">
                <option value="ALL" ${(!officialFilters.studentClass || officialFilters.studentClass === 'ALL') ? 'selected' : ''}>All Classes (${yearStudents.length})</option>
                ${classOptions.map((className) => `<option value="${escapeHtml(className)}" ${officialFilters.studentClass === className ? 'selected' : ''}>Class ${escapeHtml(className)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-[9px] sm:text-[10px] font-extrabold uppercase tracking-wider text-slate-500 mb-0.5 sm:mb-1">Gender</label>
              <select id="official-student-gender" class="w-full py-1.5 sm:py-2 px-2 sm:px-2.5 rounded-lg sm:rounded-xl border border-slate-300 bg-white text-xs font-bold text-slate-800 shadow-2xs focus:border-blue-500">
                <option value="ALL">All Genders</option>
                <option value="Male" ${officialFilters.studentGender === 'Male' ? 'selected' : ''}>Male</option>
                <option value="Female" ${officialFilters.studentGender === 'Female' ? 'selected' : ''}>Female</option>
              </select>
            </div>
            <div>
              <label class="block text-[9px] sm:text-[10px] font-extrabold uppercase tracking-wider text-slate-500 mb-0.5 sm:mb-1">Filter</label>
              <select id="official-student-info" class="w-full py-1.5 sm:py-2 px-2 sm:px-2.5 rounded-lg sm:rounded-xl border border-slate-300 bg-white text-xs font-bold text-slate-800 shadow-2xs focus:border-blue-500">
                <option value="ALL">All Students</option>
                <option value="GROUPED" ${officialFilters.studentInfo === 'GROUPED' ? 'selected' : ''}>Grouped</option>
                <option value="CONCESSION" ${officialFilters.studentInfo === 'CONCESSION' ? 'selected' : ''}>Concession</option>
                <option value="MISSING_MOBILE" ${officialFilters.studentInfo === 'MISSING_MOBILE' ? 'selected' : ''}>Missing Mobile</option>
                <option value="MISSING_UID" ${officialFilters.studentInfo === 'MISSING_UID' ? 'selected' : ''}>Missing UID</option>
              </select>
            </div>
            <div class="col-span-2">
              <label class="block text-[9px] sm:text-[10px] font-extrabold uppercase tracking-wider text-slate-500 mb-0.5 sm:mb-1">Search Student</label>
              <div class="relative">
                <i class="fas fa-search absolute left-2.5 sm:left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                <input id="official-student-search" type="text" value="${escapeHtml(officialFilters.studentSearch)}" class="w-full pl-7 sm:pl-8 pr-2.5 sm:pr-3 py-1.5 sm:py-2 rounded-lg sm:rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 shadow-2xs focus:border-blue-500" placeholder="Search by name, adm no, UID, parent, mobile, Aadhaar...">
              </div>
            </div>
          </div>

          <!-- Top Pagination & Row Limit Bar -->
          <div class="flex flex-wrap items-center justify-between gap-2 mb-3 px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-xl bg-slate-100/80 border border-slate-200 text-xs">
            <div class="flex items-center gap-1.5 font-bold text-slate-700">
              <span class="text-[11px] sm:text-xs">Rows:</span>
              <select id="official-student-page-size" class="px-2 py-1 rounded-lg border border-slate-300 bg-white font-extrabold text-slate-800 text-[11px] sm:text-xs">
                <option value="10" ${officialFilters.studentPageSize === 10 ? 'selected' : ''}>10</option>
                <option value="25" ${officialFilters.studentPageSize === 25 ? 'selected' : ''}>25</option>
                <option value="50" ${officialFilters.studentPageSize === 50 ? 'selected' : ''}>50</option>
                <option value="100" ${officialFilters.studentPageSize === 100 ? 'selected' : ''}>100</option>
                <option value="0" ${officialFilters.studentPageSize === 0 ? 'selected' : ''}>All (${totalCount})</option>
              </select>
              <span class="text-slate-500 text-[11px] sm:text-xs ml-0.5">
                <b class="text-slate-900">${totalCount ? startIdx + 1 : 0}</b>–<b class="text-slate-900">${endIdx}</b> of <b class="text-slate-900">${totalCount}</b>
              </span>
            </div>
            <div class="flex items-center gap-1.5">
              <button type="button" id="official-stu-prev" ${officialFilters.studentPage <= 1 ? 'disabled' : ''} class="px-2.5 py-1 rounded-lg border border-slate-300 bg-white font-extrabold text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:pointer-events-none cursor-pointer text-[11px] sm:text-xs">
                <i class="fas fa-chevron-left mr-0.5 text-[9px]"></i> Prev
              </button>
              <span class="font-extrabold text-slate-700 px-1 text-[11px] sm:text-xs">${officialFilters.studentPage}/${totalPages}</span>
              <button type="button" id="official-stu-next" ${officialFilters.studentPage >= totalPages ? 'disabled' : ''} class="px-2.5 py-1 rounded-lg border border-slate-300 bg-white font-extrabold text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:pointer-events-none cursor-pointer text-[11px] sm:text-xs">
                Next <i class="fas fa-chevron-right ml-0.5 text-[9px]"></i>
              </button>
            </div>
          </div>

          <!-- Full-Screen Responsive Data Table with Sticky Header & Sticky Left Columns (Desktop only) -->
          <div class="stu-reg-scroll-wrap hidden md:block w-full rounded-xl border border-slate-200">
            <table class="stu-reg-table w-full text-xs min-w-[1400px]">
              <thead>
                <tr class="bg-slate-100 text-slate-700">
                  <th class="stu-sticky-col-1 px-2.5 py-2.5 w-12 text-center font-extrabold">NO</th>
                  <th class="stu-sticky-col-2 px-2 py-2.5 text-center w-14 font-extrabold">Profile</th>
                  ${headerCells}
                </tr>
              </thead>
              <tbody>
                ${rows || `<tr><td colspan="${coreAdminColumns.length + 2}" class="p-6 text-center text-slate-500 font-semibold">${emptyStudentMessage}</td></tr>`}
              </tbody>
            </table>
          </div>

          <!-- Mobile Cards View (Mobile only) -->
          <div class="official-mobile-card-list block md:hidden mt-4 space-y-2.5">${cardRows || `<div class="text-sm text-slate-500 text-center py-4">${emptyStudentMessage}</div>`}</div>

          <!-- Bottom Pagination Bar -->
          <div class="flex flex-wrap items-center justify-between gap-3 mt-3 px-3 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs">
            <div class="font-bold text-slate-600">
              Showing rows <b class="text-slate-900">${totalCount ? startIdx + 1 : 0}</b> to <b class="text-slate-900">${endIdx}</b> of <b class="text-slate-900">${totalCount}</b> students
            </div>
            <div class="flex items-center gap-2">
              <button type="button" id="official-stu-prev-bottom" ${officialFilters.studentPage <= 1 ? 'disabled' : ''} class="px-3.5 py-1.5 rounded-lg border border-slate-300 bg-white font-extrabold text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none cursor-pointer">
                <i class="fas fa-chevron-left mr-1 text-[10px]"></i> Previous
              </button>
              <span class="font-extrabold text-slate-800 px-2">Page ${officialFilters.studentPage} / ${totalPages}</span>
              <button type="button" id="official-stu-next-bottom" ${officialFilters.studentPage >= totalPages ? 'disabled' : ''} class="px-3.5 py-1.5 rounded-lg border border-slate-300 bg-white font-extrabold text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none cursor-pointer">
                Next <i class="fas fa-chevron-right ml-1 text-[10px]"></i>
              </button>
            </div>
          </div>
        </div>`;

      document.getElementById('official-student-year')?.addEventListener('change', (e) => {
        officialFilters.academicYearId = e.target.value;
        officialFilters.studentPage = 1;
        buildClassSummary();
        renderStudents();
      });
      document.getElementById('official-student-class')?.addEventListener('change', (e) => {
        officialFilters.studentClass = e.target.value;
        officialFilters.studentPage = 1;
        renderStudents();
      });
      document.getElementById('official-student-gender')?.addEventListener('change', (e) => {
        officialFilters.studentGender = e.target.value;
        officialFilters.studentPage = 1;
        renderStudents();
      });
      document.getElementById('official-student-info')?.addEventListener('change', (e) => {
        officialFilters.studentInfo = e.target.value;
        officialFilters.studentPage = 1;
        renderStudents();
      });
      document.getElementById('official-student-search')?.addEventListener('input', (e) => {
        const cursorPos = e.target.selectionStart;
        officialFilters.studentSearch = e.target.value;
        officialFilters.studentPage = 1;
        renderStudents();
        const searchInput = document.getElementById('official-student-search');
        if (searchInput) {
          searchInput.focus();
          try { searchInput.setSelectionRange(cursorPos, cursorPos); } catch (_err) {}
        }
      });
      document.getElementById('official-student-page-size')?.addEventListener('change', (e) => {
        officialFilters.studentPageSize = Number(e.target.value);
        officialFilters.studentPage = 1;
        renderStudents();
      });

      const goPrevPage = () => {
        if (officialFilters.studentPage > 1) {
          officialFilters.studentPage -= 1;
          renderStudents();
        }
      };
      const goNextPage = () => {
        if (officialFilters.studentPage < totalPages) {
          officialFilters.studentPage += 1;
          renderStudents();
        }
      };
      document.getElementById('official-stu-prev')?.addEventListener('click', goPrevPage);
      document.getElementById('official-stu-next')?.addEventListener('click', goNextPage);
      document.getElementById('official-stu-prev-bottom')?.addEventListener('click', goPrevPage);
      document.getElementById('official-stu-next-bottom')?.addEventListener('click', goNextPage);

      document.getElementById('btn-students-export-excel')?.addEventListener('click', () => exportStudentsToExcel(filteredStudents));
      document.getElementById('btn-students-export-pdf')?.addEventListener('click', () => printStudentsRegisterPdf(filteredStudents));

      document.querySelectorAll('[data-student-id]').forEach((el) => el.addEventListener('click', () => {
        const student = yearStudents.find((item) => item.id === el.dataset.studentId) || allStudents.find((item) => item.id === el.dataset.studentId);
        if (student) {
          openOfficialDetailModal('Student Profile', buildStudentDetailHtml(student));
          attachStudentModalTabs();
        }
      }));
    };

    const exportAlumniToExcel = (alumniToExport = []) => {
      if (typeof XLSX === 'undefined') {
        openOfficialDetailModal('Export Notice', '<p class="text-sm text-slate-600 p-4">Excel library is still loading. Please try again in a moment.</p>');
        return;
      }
      const rowsData = alumniToExport.map((s, idx) => ({
        'No': idx + 1,
        'Adm No': s.adm || '',
        'Student Name': s.name || '',
        'Gender': s.gender || '',
        'Alumni Year': getAlumniGraduatedYear(s),
        'Completed Class': s.finalClass || s.promotedFrom || 'Completed',
        'Father / Guardian': s.father || s.guardian || '',
        'Mobile Number': s.mobile || s.phone || '',
        'Address': s.address || s.place || '',
        'Status': 'Alumni'
      }));
      const ws = XLSX.utils.json_to_sheet(rowsData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Alumni Register');
      const yearLabel = officialFilters.alumniYear || 'All_Years';
      XLSX.writeFile(wb, `Alumni_Register_${yearLabel}.xlsx`);
    };

    const printAlumniRegisterPdf = (alumniToPrint = []) => {
      const instName = resolveInstitutionName(institutionConfig) || 'Institution Official Portal';
      const yearTitle = (!officialFilters.alumniYear || officialFilters.alumniYear === 'ALL')
        ? 'All Alumni Years'
        : `Alumni Year: ${officialFilters.alumniYear}`;

      let printContainer = document.getElementById('alumni-register-print-area');
      if (!printContainer) {
        printContainer = document.createElement('div');
        printContainer.id = 'alumni-register-print-area';
        printContainer.className = 'hidden';
        document.body.appendChild(printContainer);
      }

      const rowsHtml = alumniToPrint.map((s, idx) => `
        <tr class="border-b border-slate-300">
          <td class="p-2 text-center text-xs">${idx + 1}</td>
          <td class="p-2 font-mono text-xs font-bold text-center">${escapeHtml(s.adm || '-')}</td>
          <td class="p-2 text-xs font-bold">${escapeHtml(s.name || '-')}</td>
          <td class="p-2 text-xs text-center">${escapeHtml(s.gender || '-')}</td>
          <td class="p-2 text-xs text-center font-semibold">${escapeHtml(getAlumniGraduatedYear(s))}</td>
          <td class="p-2 text-xs text-center font-semibold">${escapeHtml(s.finalClass || s.promotedFrom || 'Completed')}</td>
          <td class="p-2 text-xs">${escapeHtml(s.father || s.guardian || '-')}</td>
          <td class="p-2 text-xs font-mono text-center">${escapeHtml(s.mobile || '-')}</td>
          <td class="p-2 text-xs">${escapeHtml(s.address || s.place || '-')}</td>
        </tr>
      `).join('');

      printContainer.innerHTML = `
        <div class="p-6 bg-white text-slate-900 printable-area">
          <div class="text-center pb-4 mb-4 border-b-2 border-slate-900">
            <h1 class="text-xl font-black uppercase tracking-wide">${escapeHtml(instName)}</h1>
            <h2 class="text-sm font-bold text-slate-700 mt-1">OFFICIAL ALUMNI REGISTER</h2>
            <p class="text-xs font-semibold text-slate-500 mt-0.5">${escapeHtml(yearTitle)} • Generated on ${new Date().toLocaleDateString()}</p>
          </div>
          <table class="w-full text-left border-collapse border border-slate-300">
            <thead>
              <tr class="bg-slate-100 text-slate-800 text-xs uppercase font-extrabold border-b border-slate-400">
                <th class="p-2 text-center w-10">No</th>
                <th class="p-2 text-center w-20">Adm No</th>
                <th class="p-2">Student Name</th>
                <th class="p-2 text-center w-16">Gender</th>
                <th class="p-2 text-center w-28">Alumni Year</th>
                <th class="p-2 text-center w-24">Final Class</th>
                <th class="p-2">Guardian</th>
                <th class="p-2 text-center w-28">Mobile</th>
                <th class="p-2">Address</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || '<tr><td colspan="9" class="p-4 text-center text-slate-500">No alumni records found</td></tr>'}
            </tbody>
          </table>
          <div class="mt-8 flex justify-between items-center text-xs font-bold text-slate-600 pt-6 border-t border-slate-200">
            <div>Total Alumni Students: <b>${alumniToPrint.length}</b></div>
            <div>Principal / Headmaster Signature: ___________________</div>
          </div>
        </div>
      `;

      const styleEl = document.createElement('style');
      styleEl.textContent = `
        @media print {
          body * { visibility: hidden !important; }
          #alumni-register-print-area, #alumni-register-print-area * { visibility: visible !important; }
          #alumni-register-print-area { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; display: block !important; }
        }
      `;
      document.head.appendChild(styleEl);
      window.print();
      setTimeout(() => {
        styleEl.remove();
        printContainer.innerHTML = '';
      }, 600);
    };

    const renderAlumniTab = () => {
      const alumniTarget = document.getElementById('official-tab-alumni');
      if (!alumniTarget) return;

      const allAlumni = allStudents.filter(isAlumniStudent);
      const distinctYears = [...new Set(allAlumni.map(getAlumniGraduatedYear))].sort((a, b) => {
        const [aStart = 0] = String(a).split('-').map(Number);
        const [bStart = 0] = String(b).split('-').map(Number);
        if (aStart && bStart) return bStart - aStart;
        return a.localeCompare(b);
      });

      const selectedYear = officialFilters.alumniYear || 'ALL';
      let filteredAlumni = allAlumni;
      if (selectedYear !== 'ALL') {
        filteredAlumni = filteredAlumni.filter((s) => getAlumniGraduatedYear(s) === selectedYear);
      }

      const searchTxt = String(officialFilters.alumniSearch || '').trim().toLowerCase();
      if (searchTxt) {
        filteredAlumni = filteredAlumni.filter((s) => {
          const searchable = [
            s.name, s.adm, s.father, s.guardian, s.mobile, s.phone, s.address, s.place, s.finalClass, s.promotedFrom, getAlumniGraduatedYear(s)
          ].filter(Boolean).join(' ').toLowerCase();
          return searchable.includes(searchTxt);
        });
      }

      filteredAlumni.sort((a, b) => {
        const yearComp = String(getAlumniGraduatedYear(b)).localeCompare(String(getAlumniGraduatedYear(a)));
        if (yearComp !== 0) return yearComp;
        return String(a.adm || '').localeCompare(String(b.adm || ''), undefined, { numeric: true }) || String(a.name || '').localeCompare(String(b.name || ''));
      });

      const totalCount = filteredAlumni.length;
      const pageSize = officialFilters.alumniPageSize === 0 ? Math.max(1, totalCount) : Number(officialFilters.alumniPageSize || 25);
      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
      if (officialFilters.alumniPage > totalPages) officialFilters.alumniPage = totalPages;
      if (officialFilters.alumniPage < 1) officialFilters.alumniPage = 1;

      const startIdx = totalCount === 0 ? 0 : (officialFilters.alumniPage - 1) * pageSize;
      const paginatedAlumni = filteredAlumni.slice(startIdx, startIdx + pageSize);

      const yearOptionsHtml = [
        `<option value="ALL" ${selectedYear === 'ALL' ? 'selected' : ''}>All Academic Years (${allAlumni.length})</option>`,
        ...distinctYears.map((yr) => {
          const cnt = allAlumni.filter((s) => getAlumniGraduatedYear(s) === yr).length;
          return `<option value="${escapeHtml(yr)}" ${selectedYear === yr ? 'selected' : ''}>Alumni (${escapeHtml(yr)}) — ${cnt} Students</option>`;
        })
      ].join('');

      const tableRowsHtml = paginatedAlumni.map((s, idx) => {
        const rowNo = startIdx + idx + 1;
        const gradYear = getAlumniGraduatedYear(s);
        const finalClass = s.finalClass || s.promotedFrom || 'Completed';
        const guardian = s.father || s.guardian || s.mother || '--';
        const contact = s.mobile || s.phone || '--';
        const address = s.address || s.place || '--';
        const gender = s.gender || '--';

        return `
          <tr class="hover:bg-amber-50/60 transition-colors odd:bg-white even:bg-slate-50/40">
            <td class="border border-slate-200 p-2.5 text-center font-bold text-slate-500">${rowNo}</td>
            <td class="border border-slate-200 p-2.5 text-center font-mono font-bold text-indigo-900 bg-indigo-50/30">${escapeHtml(s.adm || '-')}</td>
            <td class="border border-slate-200 p-2.5">
              <div class="flex items-center gap-2.5">
                ${renderAvatarMarkup(s, s.name, 'w-8 h-8 rounded-lg text-xs')}
                <div>
                  <button type="button" class="font-extrabold text-slate-900 hover:text-indigo-700 hover:underline cursor-pointer text-left" data-alumni-id="${escapeHtml(s.id)}">
                    ${escapeHtml(s.name || 'Unnamed')}
                  </button>
                  <div class="text-[10px] text-amber-700 font-bold">🎓 Alumni: ${escapeHtml(gradYear)}</div>
                </div>
              </div>
            </td>
            <td class="border border-slate-200 p-2.5 text-center font-semibold text-slate-700">${escapeHtml(gender)}</td>
            <td class="border border-slate-200 p-2.5 text-center">
              <span class="px-2 py-0.5 rounded-full text-[11px] font-extrabold bg-amber-100 text-amber-800 border border-amber-200">
                ${escapeHtml(gradYear)}
              </span>
            </td>
            <td class="border border-slate-200 p-2.5 text-center font-bold text-slate-800">
              Class ${escapeHtml(finalClass)}
            </td>
            <td class="border border-slate-200 p-2.5 font-medium text-slate-700">${escapeHtml(guardian)}</td>
            <td class="border border-slate-200 p-2.5 text-center font-mono text-xs font-semibold text-slate-700">
              ${contact !== '--' ? `<a href="tel:${escapeHtml(contact)}" class="text-blue-700 hover:underline"><i class="fas fa-phone-alt text-[10px] mr-1"></i>${escapeHtml(contact)}</a>` : '--'}
            </td>
            <td class="border border-slate-200 p-2.5 text-slate-600 text-xs max-w-[180px] truncate" title="${escapeHtml(address)}">${escapeHtml(address)}</td>
            <td class="border border-slate-200 p-2.5 text-center">
              <button type="button" class="px-2.5 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-bold border border-indigo-200 cursor-pointer transition shadow-2xs" data-alumni-id="${escapeHtml(s.id)}">
                <i class="fas fa-eye mr-1"></i> Profile
              </button>
            </td>
          </tr>
        `;
      }).join('');

      alumniTarget.innerHTML = `
        <div class="card p-3 sm:p-5 rounded-2xl shadow-sm w-full max-w-none space-y-4">
          <!-- Top Header Strip -->
          <div class="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
            <div>
              <h3 class="font-extrabold text-lg text-slate-900 flex items-center gap-2">
                <span class="w-8 h-8 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center text-sm font-bold border border-amber-200">
                  <i class="fas fa-user-graduate"></i>
                </span>
                <span>Alumni Register</span>
              </h3>
              <p class="text-xs text-slate-500 font-semibold mt-0.5">Permanent historical archive of all alumni students across academic years.</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs font-extrabold px-3 py-2 rounded-xl bg-amber-50 text-amber-800 border border-amber-200 shadow-2xs">
                Total Alumni: <b>${allAlumni.length}</b> (Filtered: ${totalCount})
              </span>
              <button id="btn-alumni-export-excel" type="button" class="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-2xs cursor-pointer flex items-center gap-1.5 transition">
                <i class="fas fa-file-excel"></i> Export Excel
              </button>
              <button id="btn-alumni-export-pdf" type="button" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs shadow-2xs cursor-pointer flex items-center gap-1.5 transition">
                <i class="fas fa-print"></i> Print / PDF
              </button>
            </div>
          </div>

          <!-- Filter Toolbar -->
          <div class="bg-slate-50 border border-slate-200 p-3 rounded-xl flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-2.5">
              <div class="flex items-center gap-1.5">
                <label for="alumni-filter-year" class="text-xs font-bold text-slate-700">Alumni Year:</label>
                <select id="alumni-filter-year" class="p-2 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm font-bold text-slate-800 shadow-2xs min-w-[200px]">
                  ${yearOptionsHtml}
                </select>
              </div>
              <div class="flex items-center gap-1.5">
                <label for="alumni-page-size" class="text-xs font-bold text-slate-700">Show:</label>
                <select id="alumni-page-size" class="p-2 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm font-bold text-slate-800 shadow-2xs">
                  <option value="25" ${pageSize === 25 ? 'selected' : ''}>25</option>
                  <option value="50" ${pageSize === 50 ? 'selected' : ''}>50</option>
                  <option value="100" ${pageSize === 100 ? 'selected' : ''}>100</option>
                  <option value="0" ${officialFilters.alumniPageSize === 0 ? 'selected' : ''}>All</option>
                </select>
              </div>
            </div>
            <div class="w-full sm:w-auto">
              <div class="relative">
                <input id="alumni-search-input" type="text" value="${escapeHtml(officialFilters.alumniSearch || '')}" placeholder="Search name, adm no, guardian..." class="w-full sm:w-72 pl-9 pr-3 py-2 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm font-semibold text-slate-800 focus:outline-none focus:border-amber-500 shadow-2xs">
                <i class="fas fa-search absolute left-3 top-2.5 text-slate-400 text-xs"></i>
              </div>
            </div>
          </div>

          <!-- Alumni Table -->
          <div class="overflow-x-auto w-full rounded-xl border border-slate-200 bg-white shadow-2xs">
            <table class="w-full text-xs sm:text-sm border-collapse min-w-[950px]">
              <thead>
                <tr class="bg-amber-50/70 text-amber-950 font-bold">
                  <th class="border border-slate-200 p-2.5 w-12 text-center">NO</th>
                  <th class="border border-slate-200 p-2.5 text-center w-24">Adm No</th>
                  <th class="border border-slate-200 p-2.5 text-left">Student Name</th>
                  <th class="border border-slate-200 p-2.5 text-center w-20">Gender</th>
                  <th class="border border-slate-200 p-2.5 text-center w-28">Alumni Year</th>
                  <th class="border border-slate-200 p-2.5 text-center w-24">Completed Class</th>
                  <th class="border border-slate-200 p-2.5 text-left">Guardian</th>
                  <th class="border border-slate-200 p-2.5 text-center w-28">Mobile</th>
                  <th class="border border-slate-200 p-2.5 text-left">Address</th>
                  <th class="border border-slate-200 p-2.5 text-center w-24">Action</th>
                </tr>
              </thead>
              <tbody>
                ${tableRowsHtml || '<tr><td colspan="10" class="border border-slate-200 p-6 text-center text-slate-500 font-medium">No alumni records found matching current filters</td></tr>'}
              </tbody>
            </table>
          </div>

          <!-- Pagination Bar -->
          <div class="flex flex-wrap items-center justify-between gap-3 pt-2 text-xs font-bold text-slate-600">
            <div>
              Showing ${totalCount === 0 ? 0 : startIdx + 1} to ${Math.min(startIdx + pageSize, totalCount)} of ${totalCount} Alumni
            </div>
            <div class="flex items-center gap-1.5">
              <button id="official-alumni-prev" class="px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-40 cursor-pointer shadow-2xs" ${officialFilters.alumniPage <= 1 ? 'disabled' : ''}>
                <i class="fas fa-chevron-left mr-1"></i> Prev
              </button>
              <span class="px-3 py-1.5 bg-slate-100 rounded-lg text-slate-700">Page ${officialFilters.alumniPage} of ${totalPages}</span>
              <button id="official-alumni-next" class="px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-40 cursor-pointer shadow-2xs" ${officialFilters.alumniPage >= totalPages ? 'disabled' : ''}>
                Next <i class="fas fa-chevron-right ml-1"></i>
              </button>
            </div>
          </div>
        </div>
      `;

      // Attach event listeners for Alumni Tab
      document.getElementById('alumni-filter-year')?.addEventListener('change', (e) => {
        officialFilters.alumniYear = e.target.value;
        officialFilters.alumniPage = 1;
        renderAlumniTab();
      });

      document.getElementById('alumni-page-size')?.addEventListener('change', (e) => {
        officialFilters.alumniPageSize = Number(e.target.value);
        officialFilters.alumniPage = 1;
        renderAlumniTab();
      });

      let searchTimer = null;
      document.getElementById('alumni-search-input')?.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          officialFilters.alumniSearch = e.target.value;
          officialFilters.alumniPage = 1;
          renderAlumniTab();
        }, 250);
      });

      document.getElementById('official-alumni-prev')?.addEventListener('click', () => {
        if (officialFilters.alumniPage > 1) {
          officialFilters.alumniPage -= 1;
          renderAlumniTab();
        }
      });

      document.getElementById('official-alumni-next')?.addEventListener('click', () => {
        if (officialFilters.alumniPage < totalPages) {
          officialFilters.alumniPage += 1;
          renderAlumniTab();
        }
      });

      document.getElementById('btn-alumni-export-excel')?.addEventListener('click', () => exportAlumniToExcel(filteredAlumni));
      document.getElementById('btn-alumni-export-pdf')?.addEventListener('click', () => printAlumniRegisterPdf(filteredAlumni));

      alumniTarget.querySelectorAll('[data-alumni-id]').forEach((el) => el.addEventListener('click', () => {
        const student = allStudents.find((item) => item.id === el.dataset.alumniId);
        if (student) {
          openOfficialDetailModal('Alumni Profile', buildStudentDetailHtml(student));
          attachStudentModalTabs();
        }
      }));
    };

    const buildClassSummary = () => {
      const yearStudents = getStudentsForCurrentAcademicYear();
      const map = new Map();
      yearStudents.forEach((student) => {
        const cls = getStudentClass(student);
        if (!map.has(cls)) map.set(cls, { boys: 0, girls: 0, total: 0, active: 0, inactive: 0, missingMobile: 0, missingUid: 0, grouped: 0, concession: 0 });
        const row = map.get(cls);
        row.total += 1;
        const gender = normalizeText(student.gender);
        if (gender === 'male') row.boys += 1;
        else if (gender === 'female') row.girls += 1;
        if (getStudentStatus(student) === 'Active') row.active += 1;
        else row.inactive += 1;
        if (!student.mobile) row.missingMobile += 1;
        if (!student.uid) row.missingUid += 1;
        if (getStudentGroup(student.id)) row.grouped += 1;
        if (hasStudentConcession(student)) row.concession += 1;
      });
      const keys = [...map.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const totals = { boys: 0, girls: 0, total: 0, active: 0, inactive: 0, missingMobile: 0, missingUid: 0, grouped: 0, concession: 0 };
      const rows = keys.map((cls, idx) => {
        const row = map.get(cls);
        Object.keys(totals).forEach((key) => { totals[key] += row[key]; });
        return `<tr class="hover:bg-indigo-50/70 transition-colors odd:bg-white even:bg-slate-50/40">
          <td class="border border-slate-200 p-2.5 text-center font-bold text-slate-500">${idx + 1}</td>
          <td class="border border-slate-200 p-2.5 font-semibold">
            <button type="button" class="text-blue-700 hover:underline font-extrabold class-filter-btn cursor-pointer" data-class="${escapeHtml(cls)}">Class ${escapeHtml(cls)}</button>
          </td>
          <td class="border border-slate-200 p-2.5 text-center font-semibold">${row.boys}</td>
          <td class="border border-slate-200 p-2.5 text-center font-semibold">${row.girls}</td>
          <td class="border border-slate-200 p-2.5 text-center font-extrabold text-slate-900 bg-slate-50">${row.total}</td>
          <td class="border border-slate-200 p-2.5 text-center text-emerald-700 font-bold">${row.active}</td>
          <td class="border border-slate-200 p-2.5 text-center text-rose-600 font-semibold">${row.inactive}</td>
          <td class="border border-slate-200 p-2.5 text-center">${row.grouped}</td>
          <td class="border border-slate-200 p-2.5 text-center">${row.concession}</td>
          <td class="border border-slate-200 p-2.5 text-center">${row.missingMobile}</td>
          <td class="border border-slate-200 p-2.5 text-center">${row.missingUid}</td>
        </tr>`;
      }).join('');

      // Gather and group Alumni records
      const alumniRecords = allStudents.filter(isAlumniStudent);
      const alumniMap = new Map();
      alumniRecords.forEach((student) => {
        const yr = getAlumniGraduatedYear(student);
        if (!alumniMap.has(yr)) {
          alumniMap.set(yr, { boys: 0, girls: 0, total: 0 });
        }
        const row = alumniMap.get(yr);
        row.total += 1;
        const gender = normalizeText(student.gender);
        if (gender === 'male') row.boys += 1;
        else if (gender === 'female') row.girls += 1;
      });

      const alumniYears = [...alumniMap.keys()].sort((a, b) => {
        const [aStart = 0] = String(a).split('-').map(Number);
        const [bStart = 0] = String(b).split('-').map(Number);
        if (aStart && bStart) return bStart - aStart;
        return a.localeCompare(b);
      });

      const alumniTotals = { boys: 0, girls: 0, total: 0 };
      const alumniRowsHtml = alumniYears.map((yr, idx) => {
        const row = alumniMap.get(yr);
        alumniTotals.boys += row.boys;
        alumniTotals.girls += row.girls;
        alumniTotals.total += row.total;
        return `<tr class="hover:bg-amber-50/70 transition-colors odd:bg-white even:bg-slate-50/40">
          <td class="border border-slate-200 p-2.5 text-center font-bold text-slate-500">${idx + 1}</td>
          <td class="border border-slate-200 p-2.5 font-bold text-slate-800">
            <button type="button" class="text-amber-800 hover:text-amber-900 hover:underline font-extrabold alumni-year-btn cursor-pointer inline-flex items-center gap-1.5" data-year="${escapeHtml(yr)}">
              <i class="fas fa-graduation-cap text-amber-600"></i>
              <span>Alumni (${escapeHtml(yr)})</span>
            </button>
          </td>
          <td class="border border-slate-200 p-2.5 text-center font-semibold">${row.boys}</td>
          <td class="border border-slate-200 p-2.5 text-center font-semibold">${row.girls}</td>
          <td class="border border-slate-200 p-2.5 text-center font-extrabold text-amber-900 bg-amber-50/50">${row.total}</td>
          <td class="border border-slate-200 p-2.5 text-center">
            <button type="button" class="px-2.5 py-1 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-800 text-xs font-bold transition alumni-year-btn cursor-pointer" data-year="${escapeHtml(yr)}">
              <i class="fas fa-list mr-1"></i> View Register
            </button>
          </td>
        </tr>`;
      }).join('');

      const summaryTarget = document.getElementById('official-tab-summary');
      if (!summaryTarget) return;

      const selectedYearValue = officialFilters.academicYearId || activeAcademicYearId || '';
      const yearOptionsHtml = academicYears.length
        ? academicYears.map((y) => `<option value="${escapeHtml(y.id)}" ${selectedYearValue === y.id ? 'selected' : ''}>Academic Year: ${escapeHtml(y.name || y.id)}${y.id === activeAcademicYearId ? ' (Active)' : ''}</option>`).join('')
        : `<option value="">Current Academic Year</option>`;

      summaryTarget.innerHTML = `
        <div class="card p-3 sm:p-5 rounded-2xl shadow-sm w-full max-w-none space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
            <div>
              <h3 class="font-extrabold text-lg text-slate-900 flex items-center gap-2">
                <i class="fas fa-chart-pie text-emerald-600"></i>
                <span>Dashboard — Class Summary</span>
              </h3>
              <p class="text-xs text-slate-500 font-semibold mt-0.5">Overview of active classes, student strength, and records. Click any class to inspect its student register.</p>
            </div>
            <div class="flex flex-wrap items-center gap-2.5">
              <select id="summary-academic-year" class="p-2 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm font-bold text-slate-800 shadow-2xs">
                ${yearOptionsHtml}
              </select>
              <span class="text-xs font-extrabold px-3 py-2 rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-200">Total Students: ${totals.total}</span>
            </div>
          </div>

          <div class="official-metric-grid">
            ${metricCard('Total Students', totals.total, 'blue', 'fa-user-graduate')}
            ${metricCard('Total Classes', keys.length, 'indigo', 'fa-chalkboard')}
            ${metricCard('Boys / Girls', `${totals.boys} / ${totals.girls}`, 'teal', 'fa-children')}
            ${metricCard('Active Students', totals.active, 'green', 'fa-user-check')}
            ${metricCard('Fee Concession', totals.concession, 'amber', 'fa-tags')}
            ${metricCard('Active Staff', allStaff.filter((s) => s.isActive !== false).length, 'purple', 'fa-users')}
          </div>

          <div class="overflow-x-auto w-full rounded-xl border border-slate-200">
            <table class="w-full text-xs sm:text-sm border-collapse min-w-[950px]">
              <thead>
                <tr class="bg-slate-100 text-slate-700">
                  <th class="border border-slate-200 p-2.5 w-12 text-center">NO</th>
                  <th class="border border-slate-200 p-2.5 text-left">Class</th>
                  <th class="border border-slate-200 p-2.5 text-center">Boys</th>
                  <th class="border border-slate-200 p-2.5 text-center">Girls</th>
                  <th class="border border-slate-200 p-2.5 text-center">Total</th>
                  <th class="border border-slate-200 p-2.5 text-center">Active</th>
                  <th class="border border-slate-200 p-2.5 text-center">Inactive</th>
                  <th class="border border-slate-200 p-2.5 text-center">Grouped</th>
                  <th class="border border-slate-200 p-2.5 text-center">Concession</th>
                  <th class="border border-slate-200 p-2.5 text-center">No Mobile</th>
                  <th class="border border-slate-200 p-2.5 text-center">No UID</th>
                </tr>
              </thead>
              <tbody>
                ${rows || '<tr><td colspan="11" class="border border-slate-200 p-4 text-center text-slate-500">No students available for this academic year</td></tr>'}
                <tr class="bg-indigo-50 font-extrabold text-slate-900">
                  <td class="border border-slate-200 p-2.5 text-center">-</td>
                  <td class="border border-slate-200 p-2.5">Grand Total</td>
                  <td class="border border-slate-200 p-2.5 text-center">${totals.boys}</td>
                  <td class="border border-slate-200 p-2.5 text-center">${totals.girls}</td>
                  <td class="border border-slate-200 p-2.5 text-center">${totals.total}</td>
                  <td class="border border-slate-200 p-2.5 text-center">${totals.active}</td>
                  <td class="border border-slate-200 p-2.5 text-center">${totals.inactive}</td>
                  <td class="border border-slate-200 p-2.5 text-center">${totals.grouped}</td>
                  <td class="border border-slate-200 p-2.5 text-center">${totals.concession}</td>
                  <td class="border border-slate-200 p-2.5 text-center">${totals.missingMobile}</td>
                  <td class="border border-slate-200 p-2.5 text-center">${totals.missingUid}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Dedicated Alumni Summary Table Section -->
          <div class="mt-8 border-t-2 border-slate-200 pt-6 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
              <div>
                <h3 class="font-extrabold text-lg text-slate-900 flex items-center gap-2">
                  <span class="w-8 h-8 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center text-sm font-bold border border-amber-200">
                    <i class="fas fa-user-graduate"></i>
                  </span>
                  <span>Alumni Summary</span>
                </h3>
                <p class="text-xs text-slate-500 font-semibold mt-0.5">Summary of alumni students by academic year (strictly excluded from active student strength).</p>
              </div>
              <span class="text-xs font-extrabold px-3 py-2 rounded-xl bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1.5 shadow-2xs">
                <i class="fas fa-graduation-cap"></i> Total Alumni: ${alumniTotals.total}
              </span>
            </div>

            <div class="overflow-x-auto w-full rounded-xl border border-slate-200 bg-white shadow-2xs">
              <table class="w-full text-xs sm:text-sm border-collapse min-w-[700px]">
                <thead>
                  <tr class="bg-amber-50/70 text-amber-950 font-bold">
                    <th class="border border-slate-200 p-2.5 w-12 text-center">NO</th>
                    <th class="border border-slate-200 p-2.5 text-left">Academic Year (Alumni Cohort)</th>
                    <th class="border border-slate-200 p-2.5 text-center">Boys</th>
                    <th class="border border-slate-200 p-2.5 text-center">Girls</th>
                    <th class="border border-slate-200 p-2.5 text-center">Total Alumni</th>
                    <th class="border border-slate-200 p-2.5 text-center w-36">Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${alumniRowsHtml || '<tr><td colspan="6" class="border border-slate-200 p-4 text-center text-slate-500">No alumni records found in database</td></tr>'}
                  <tr class="bg-amber-100/60 font-extrabold text-amber-950">
                    <td class="border border-slate-200 p-2.5 text-center">-</td>
                    <td class="border border-slate-200 p-2.5">Grand Total Alumni</td>
                    <td class="border border-slate-200 p-2.5 text-center">${alumniTotals.boys}</td>
                    <td class="border border-slate-200 p-2.5 text-center">${alumniTotals.girls}</td>
                    <td class="border border-slate-200 p-2.5 text-center">${alumniTotals.total}</td>
                    <td class="border border-slate-200 p-2.5 text-center">-</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>`;

      document.getElementById('summary-academic-year')?.addEventListener('change', (e) => {
        officialFilters.academicYearId = e.target.value;
        officialFilters.studentPage = 1;
        buildClassSummary();
        renderStudents();
      });

      document.querySelectorAll('.class-filter-btn').forEach((btn) => btn.addEventListener('click', () => {
        officialFilters.studentClass = btn.dataset.class || 'ALL';
        officialFilters.studentPage = 1;
        renderStudents();
        setTab('students');
      }));

      document.querySelectorAll('.alumni-year-btn').forEach((btn) => btn.addEventListener('click', () => {
        officialFilters.alumniYear = btn.dataset.year || 'ALL';
        officialFilters.alumniPage = 1;
        renderAlumniTab();
        setTab('alumni');
      }));
    };

    const normalizeConfiguredFields = (fields = []) => (Array.isArray(fields) ? fields : [])
      .map((field) => ({ ...field, key: String(field.key || ''), label: String(field.label || field.key || ''), order: Number(field.order || 999) }))
      .filter((field) => field.key && !isSensitiveProfileField(field.key, field.label))
      .sort((a, b) => a.order - b.order);
    const getDirectoryCategory = (categoryId = '') => directoryCategories.find((category) => category.id === categoryId);
    const getCategoryAuthItem = (categoryId = '') => {
      const raw = categoryAuthConfig?.categories?.[categoryId] || {};
      return { enabled: raw.enabled === true, targetPage: raw.targetPage === 'student' ? 'student' : 'collection', usernameField: String(raw.usernameField || ''), passwordField: String(raw.passwordField || '') };
    };
    const getPageAccessItem = (categoryId = '', entryId = '') => {
      const categoryAccess = pageAccessConfig?.categories?.[categoryId] || {};
      const override = pageAccessConfig?.overrides?.[entryId] || {};
      if (override.blocked === true) return { collection: false, student: false, blocked: true };
      return { collection: typeof override.collection === 'boolean' ? override.collection : categoryAccess.collection === true, student: typeof override.student === 'boolean' ? override.student : categoryAccess.student === true, blocked: false };
    };
    const buildStaffDetailHtml = (staff = {}) => {
      const photoUrl = getPhoto(staff);
      const isActive = staff.isActive !== false;
      const role = staff.role || staff.designation || staff.type || 'Staff Member';
      const allEntries = getStaffProfileEntries(staff).filter(
        (entry) => entry && entry.key !== 'name' && !isSensitiveProfileField(entry.key, entry.label) && valueToDisplay(entry.value) !== '--'
      );

      return `
        <div class="space-y-4">
          <!-- Profile Header Banner -->
          <div class="flex flex-col sm:flex-row items-center sm:items-start gap-4 p-4 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-800 to-emerald-950 text-white shadow-md">
            <div class="relative w-20 h-20 rounded-2xl overflow-hidden border-2 border-white/20 bg-slate-800 flex-shrink-0 shadow">
              ${(staff.photo || staff.image) ? `<img src="${escapeHtml(photoUrl)}" alt="${escapeHtml(staff.name || 'Staff')}" class="w-full h-full object-cover" onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.classList.remove('hidden');"><div class="hidden w-full h-full bg-slate-800 flex items-center justify-center text-slate-400"><i class="fas fa-user text-2xl"></i></div>` : `<div class="w-full h-full bg-slate-800 flex items-center justify-center text-slate-400"><i class="fas fa-user text-2xl"></i></div>`}
            </div>
            <div class="text-center sm:text-left flex-1 min-w-0">
              <div class="flex flex-wrap items-center justify-center sm:justify-start gap-2 mb-1">
                <h3 class="text-xl font-extrabold text-white truncate">${escapeHtml(staff.name || '--')}</h3>
                <span class="px-2.5 py-0.5 rounded-full text-xs font-bold ${isActive ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30' : 'bg-slate-700 text-slate-300'}">${isActive ? 'Active Staff' : 'Inactive'}</span>
              </div>
              <p class="text-xs font-semibold text-emerald-200">
                Designation: <b class="text-white">${escapeHtml(role)}</b> &nbsp;•&nbsp;
                Type: <b class="text-white">${escapeHtml(staff.type || '--')}</b>
              </p>
            </div>
          </div>

          <!-- Dynamic Complete Admin-Added Details Grid -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${allEntries.map((entry) => {
              const isPhone = entry.key === 'phone' || entry.key === 'mobile';
              const isWide = entry.key === 'address' || String(valueToDisplay(entry.value)).length > 45;
              return `
                <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 ${isWide ? 'sm:col-span-2' : ''}">
                  <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">${escapeHtml(entry.label || toLabel(entry.key))}</span>
                  <div class="font-bold text-slate-900 text-sm mt-0.5 flex items-center justify-between gap-2 break-words">
                    <span>${escapeHtml(valueToDisplay(entry.value))}</span>
                    ${isPhone && entry.value ? `<a href="tel:${escapeHtml(String(entry.value))}" class="text-emerald-600 hover:text-emerald-800 p-1 shrink-0" title="Call Staff"><i class="fas fa-phone-alt text-xs"></i></a>` : ''}
                  </div>
                </div>`;
            }).join('')}
          </div>

          <!-- Module Permissions Matrix -->
          <div class="rounded-2xl border border-slate-200 p-4 bg-white shadow-xs">
            <h4 class="font-extrabold text-xs text-slate-500 uppercase tracking-wider mb-3">System Module Permissions</h4>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div class="p-2.5 rounded-xl border ${staff.canCollect !== false ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-500'} font-bold flex items-center gap-2">
                <i class="fas ${staff.canCollect !== false ? 'fa-check-circle text-emerald-600' : 'fa-times-circle text-slate-400'}"></i>
                <span>Fee Collection</span>
              </div>
              <div class="p-2.5 rounded-xl border ${staff.canManageResults === true ? 'border-blue-200 bg-blue-50 text-blue-800' : 'border-slate-200 bg-slate-50 text-slate-500'} font-bold flex items-center gap-2">
                <i class="fas ${staff.canManageResults === true ? 'fa-check-circle text-blue-600' : 'fa-times-circle text-slate-400'}"></i>
                <span>Result System</span>
              </div>
              <div class="p-2.5 rounded-xl border ${staff.canAccessWorksheet !== false ? 'border-teal-200 bg-teal-50 text-teal-800' : 'border-slate-200 bg-slate-50 text-slate-500'} font-bold flex items-center gap-2">
                <i class="fas ${staff.canAccessWorksheet !== false ? 'fa-check-circle text-teal-600' : 'fa-times-circle text-slate-400'}"></i>
                <span>Worksheet</span>
              </div>
              <div class="p-2.5 rounded-xl border ${(staff.canAccessAdmin === true || staff.type === 'Admin') ? 'border-indigo-200 bg-indigo-50 text-indigo-800' : 'border-slate-200 bg-slate-50 text-slate-500'} font-bold flex items-center gap-2">
                <i class="fas ${(staff.canAccessAdmin === true || staff.type === 'Admin') ? 'fa-check-circle text-indigo-600' : 'fa-times-circle text-slate-400'}"></i>
                <span>Admin Panel</span>
              </div>
            </div>
          </div>
        </div>`;
    };

    const buildDirectoryDetailHtml = (entry = {}, category = getDirectoryCategory(entry.categoryId)) => {
      const photoUrl = getPhoto(entry.values || entry);
      const authItem = getCategoryAuthItem(entry.categoryId);
      const hiddenKeys = new Set([authItem.usernameField, authItem.passwordField].filter(Boolean));
      const visibleFields = normalizeConfiguredFields(category?.fields || []).filter((f) => !hiddenKeys.has(f.key));

      return `
        <div class="space-y-4">
          <div class="flex flex-col sm:flex-row items-center sm:items-start gap-4 p-4 rounded-2xl bg-gradient-to-r from-slate-900 to-indigo-950 text-white shadow-md">
            <div class="relative w-16 h-16 rounded-2xl overflow-hidden border-2 border-white/20 bg-slate-800 flex-shrink-0 shadow">
              <img src="${escapeHtml(photoUrl)}" alt="Member" class="w-full h-full object-cover" onerror="this.onerror=null;this.src='assets/images/logo.png'">
            </div>
            <div>
              <h3 class="text-xl font-extrabold text-white">${escapeHtml(entry.values?.name || entry.values?.title || 'Member Profile')}</h3>
              <p class="text-xs font-semibold text-indigo-200">Category: <b class="text-white">${escapeHtml(category?.name || 'Directory Category')}</b></p>
            </div>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${visibleFields.map((f) => `
              <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">${escapeHtml(f.label)}</span>
                <div class="font-bold text-slate-900 text-sm mt-0.5">${escapeHtml(valueToDisplay(entry.values?.[f.key]))}</div>
              </div>
            `).join('')}
          </div>
        </div>`;
    };

    const exportStaffToExcel = (staffList = []) => {
      if (typeof XLSX === 'undefined') {
        openOfficialDetailModal('Export Notice', '<p class="text-sm text-slate-600 p-4">Excel library is still loading. Please try again in a moment.</p>');
        return;
      }
      const rowsData = staffList.map((s, idx) => {
        const customVals = (s.customValues && typeof s.customValues === 'object') ? s.customValues : {};
        return {
          'No': idx + 1,
          'Full Name': s.name || customVals.name || '',
          'Role / Designation': s.role || s.designation || customVals.role || s.type || '',
          'Category': s.type || '',
          'MSR / Staff ID': s.msr || customVals.msr || '',
          'Phone Number': s.phone || s.mobile || customVals.phone || '',
          'Email': s.email || customVals.email || '',
          'Qualification': s.qualification || customVals.qualification || '',
          'Subject / Dept': s.subject || customVals.subject || '',
          'Joining Date': s.joiningDate || customVals.joiningDate || '',
          'Duty Classes': Array.isArray(s.dutyClasses) && s.dutyClasses.length ? s.dutyClasses.join(', ') : 'All',
          'Status': s.isActive !== false ? 'Active' : 'Inactive',
          'Address': s.address || customVals.address || ''
        };
      });
      const ws = XLSX.utils.json_to_sheet(rowsData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Staff Directory');
      XLSX.writeFile(wb, `Staff_Directory_${formatDate(new Date())}.xlsx`);
    };

    const printStaffDirectoryPdf = (staffList = []) => {
      const instName = resolveInstitutionName(institutionConfig) || 'Institution Official Portal';
      let printContainer = document.getElementById('staff-register-print-area');
      if (!printContainer) {
        printContainer = document.createElement('div');
        printContainer.id = 'staff-register-print-area';
        printContainer.className = 'hidden';
        document.body.appendChild(printContainer);
      }

      printContainer.innerHTML = `
        <div class="p-4 bg-white text-slate-900">
          <div class="text-center border-b-2 border-slate-800 pb-3 mb-4">
            <h1 class="text-xl font-black uppercase">${escapeHtml(instName)}</h1>
            <p class="text-xs font-bold text-slate-600 mt-0.5">Staff Directory Register (${staffList.length} Members)</p>
          </div>
          <table class="w-full text-[10px] border-collapse border border-slate-400">
            <thead>
              <tr class="bg-slate-100">
                <th class="border border-slate-400 p-1">No</th>
                <th class="border border-slate-400 p-1 text-left">Full Name</th>
                <th class="border border-slate-400 p-1 text-left">Designation / Role</th>
                <th class="border border-slate-400 p-1">Category</th>
                <th class="border border-slate-400 p-1">MSR / ID</th>
                <th class="border border-slate-400 p-1">Phone</th>
                <th class="border border-slate-400 p-1">Qualification</th>
                <th class="border border-slate-400 p-1">Duty Classes</th>
                <th class="border border-slate-400 p-1">Status</th>
                <th class="border border-slate-400 p-1 text-left">Address</th>
              </tr>
            </thead>
            <tbody>
              ${staffList.map((s, idx) => {
                const customVals = (s.customValues && typeof s.customValues === 'object') ? s.customValues : {};
                const duty = Array.isArray(s.dutyClasses) && s.dutyClasses.length ? s.dutyClasses.join(', ') : 'All';
                return `
                  <tr>
                    <td class="border border-slate-400 p-1 text-center font-bold">${idx + 1}</td>
                    <td class="border border-slate-400 p-1 font-bold">${escapeHtml(s.name || customVals.name || '--')}</td>
                    <td class="border border-slate-400 p-1">${escapeHtml(s.role || s.designation || customVals.role || s.type || '--')}</td>
                    <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.type || '--')}</td>
                    <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.msr || customVals.msr || '--')}</td>
                    <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.phone || s.mobile || customVals.phone || '--')}</td>
                    <td class="border border-slate-400 p-1 text-center">${escapeHtml(s.qualification || customVals.qualification || '--')}</td>
                    <td class="border border-slate-400 p-1 text-center">${escapeHtml(duty)}</td>
                    <td class="border border-slate-400 p-1 text-center">${s.isActive !== false ? 'Active' : 'Inactive'}</td>
                    <td class="border border-slate-400 p-1">${escapeHtml(s.address || customVals.address || '--')}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;

      const styleEl = document.createElement('style');
      styleEl.id = 'staff-register-print-style';
      styleEl.textContent = `
        @media print {
          body.printing-staff-register > *:not(#staff-register-print-area) { display: none !important; }
          body.printing-staff-register #staff-register-print-area { display: block !important; position: static !important; width: 100% !important; }
        }
      `;
      document.head.appendChild(styleEl);
      document.body.classList.add('printing-staff-register');
      window.print();
      setTimeout(() => {
        document.body.classList.remove('printing-staff-register');
        styleEl.remove();
      }, 600);
    };

    const renderStaffTab = () => {
      const filteredStaff = allStaff.filter((staff) => {
        const type = String(staff.type || '--');
        const status = staff.isActive === false ? 'inactive' : 'active';
        const search = Object.values(staff || {}).map(valueToDisplay).join(' ').toLowerCase();
        const typeOk = officialFilters.staffType === 'ALL' || type === officialFilters.staffType;
        const statusOk = officialFilters.staffStatus === 'ALL' || status === officialFilters.staffStatus;
        const searchOk = !officialFilters.staffSearch || search.includes(officialFilters.staffSearch.toLowerCase());
        return typeOk && statusOk && searchOk;
      }).sort((a, b) => Number(a.displayOrder || 999) - Number(b.displayOrder || 999));

      const staffTypes = [...new Set(allStaff.map((staff) => String(staff.type || '--')))].sort((a, b) => a.localeCompare(b));

      const staffTableRowsHtml = filteredStaff.map((staff, idx) => {
        const isActive = staff.isActive !== false;
        const customVals = (staff.customValues && typeof staff.customValues === 'object') ? staff.customValues : {};
        const dutyClasses = Array.isArray(staff.dutyClasses) && staff.dutyClasses.length ? staff.dutyClasses.join(', ') : 'All';
        const roleLabel = staff.role || staff.designation || customVals.role || staff.type || 'Staff';
        const msrVal = staff.msr || customVals.msr || '--';
        const phoneVal = staff.phone || staff.mobile || customVals.phone || '--';
        const qualVal = staff.qualification || customVals.qualification || '--';
        const joinVal = staff.joiningDate || customVals.joiningDate || '--';
        const addrVal = staff.address || customVals.address || '--';

        return `
          <tr class="hover:bg-indigo-50/70 cursor-pointer transition-colors odd:bg-white even:bg-slate-50/40" data-staff-id="${escapeHtml(staff.id)}">
            <td class="border border-slate-200 px-2.5 py-2 text-center font-extrabold text-slate-600">${idx + 1}</td>
            <td class="border border-slate-200 px-2 py-1.5 text-center align-middle">
              ${renderAvatarMarkup(staff, staff.name, 'w-9 h-9 rounded-xl text-xs')}
            </td>
            <td class="border border-slate-200 px-3 py-2 align-middle font-extrabold text-slate-900 whitespace-nowrap">${escapeHtml(staff.name || '--')}</td>
            <td class="border border-slate-200 px-2.5 py-2 align-middle font-semibold text-slate-700 whitespace-nowrap">${escapeHtml(roleLabel)}</td>
            <td class="border border-slate-200 px-2.5 py-2 align-middle text-center whitespace-nowrap">
              <span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-bold text-xs">${escapeHtml(staff.type || '--')}</span>
            </td>
            <td class="border border-slate-200 px-2.5 py-2 align-middle text-center font-mono text-slate-700 whitespace-nowrap">${escapeHtml(msrVal)}</td>
            <td class="border border-slate-200 px-2.5 py-2 align-middle font-mono font-bold text-slate-800 whitespace-nowrap">${escapeHtml(phoneVal)}</td>
            <td class="border border-slate-200 px-2.5 py-2 align-middle text-slate-700 whitespace-nowrap">${escapeHtml(qualVal)}</td>
            <td class="border border-slate-200 px-2.5 py-2 align-middle text-indigo-700 font-bold whitespace-nowrap">${escapeHtml(dutyClasses)}</td>
            <td class="border border-slate-200 px-2.5 py-2 align-middle text-slate-600 whitespace-nowrap">${escapeHtml(joinVal)}</td>
            <td class="border border-slate-200 px-2.5 py-2 align-middle max-w-[200px] truncate text-slate-600" title="${escapeHtml(addrVal)}">${escapeHtml(addrVal)}</td>
            <td class="border border-slate-200 px-2.5 py-2 align-middle whitespace-nowrap">
              <div class="flex items-center gap-1">
                ${staff.canCollect !== false ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Fee</span>` : ''}
                ${staff.canManageResults === true ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">Result</span>` : ''}
                ${staff.canAccessWorksheet !== false ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-teal-50 text-teal-700 border border-teal-200">Sheet</span>` : ''}
              </div>
            </td>
            <td class="border border-slate-200 px-2.5 py-2 align-middle text-center whitespace-nowrap">
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${isActive ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}">
                ${isActive ? 'Active' : 'Inactive'}
              </span>
            </td>
          </tr>`;
      }).join('');

      const catBlocks = directoryCategories.map((cat) => {
        const entries = directoryEntries.filter((entry) => entry.categoryId === cat.id).sort((a, b) => Number(a.displayOrder || 999) - Number(b.displayOrder || 999));
        const authItem = getCategoryAuthItem(cat.id);
        const hiddenKeys = new Set([authItem.usernameField, authItem.passwordField, 'photo', 'image', 'logo'].filter(Boolean));
        const visibleFields = normalizeConfiguredFields(cat?.fields || []).filter((f) => f.key && !hiddenKeys.has(f.key) && f.type !== 'photo' && f.type !== 'password');

        return `
          <div class="border border-slate-200 rounded-2xl p-4 bg-white shadow-xs">
            <div class="flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
              <div>
                <h4 class="font-extrabold text-slate-900 text-sm">${escapeHtml(cat.name || 'Category')}</h4>
                <span class="text-xs text-slate-500 font-semibold">${entries.length} registered members</span>
              </div>
            </div>
            <div class="overflow-x-auto w-full rounded-xl border border-slate-200">
              <table class="w-full text-xs border-collapse min-w-[700px]">
                <thead>
                  <tr class="bg-slate-100 text-slate-700">
                    <th class="border border-slate-200 px-2.5 py-2 w-12 text-center font-extrabold">NO</th>
                    <th class="border border-slate-200 px-2 py-2 w-14 text-center font-extrabold">Avatar</th>
                    ${visibleFields.map((f) => `<th class="border border-slate-200 px-2.5 py-2 text-left font-extrabold whitespace-nowrap">${escapeHtml(f.label)}</th>`).join('')}
                  </tr>
                </thead>
                <tbody>
                  ${entries.map((entry, idx) => {
                    const memberName = entry.values?.name || entry.values?.title || 'Member';
                    return `
                      <tr class="hover:bg-blue-50/70 cursor-pointer transition-colors odd:bg-white even:bg-slate-50/40" data-dir-id="${escapeHtml(entry.id)}">
                        <td class="border border-slate-200 px-2.5 py-2 text-center font-bold text-slate-600">${idx + 1}</td>
                        <td class="border border-slate-200 px-2 py-1.5 text-center align-middle">
                          ${renderAvatarMarkup(entry.values || entry, memberName, 'w-9 h-9 rounded-xl text-xs')}
                        </td>
                        ${visibleFields.map((f) => `<td class="border border-slate-200 px-2.5 py-2 align-middle font-semibold text-slate-800">${escapeHtml(valueToDisplay(entry.values?.[f.key]) || '--')}</td>`).join('')}
                      </tr>`;
                  }).join('') || `<tr><td colspan="${visibleFields.length + 2}" class="border border-slate-200 p-4 text-center text-slate-400">No entries in this category</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>`;
      }).join('');

      const staffTarget = document.getElementById('official-tab-staff');
      if (!staffTarget) return;

      staffTarget.innerHTML = `
        <div class="card p-3 sm:p-5 rounded-2xl shadow-sm w-full max-w-none">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-4 pb-3 border-b border-slate-100">
            <div>
              <h3 class="font-extrabold text-lg text-slate-900 flex items-center gap-2">
                <i class="fas fa-users text-indigo-600"></i>
                <span>Staff & Directory Register</span>
                <span class="text-xs font-extrabold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">${filteredStaff.length} Staff</span>
              </h3>
              <p class="text-xs text-slate-500 font-semibold mt-0.5">Structured tabular register of staff and institutional directory members. Click any row for full profile details.</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" id="btn-staff-export-pdf" class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-extrabold text-white bg-rose-600 hover:bg-rose-700 shadow-xs transition-all cursor-pointer">
                <i class="fas fa-file-pdf"></i>
                <span>PDF / Print</span>
              </button>
              <button type="button" id="btn-staff-export-excel" class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-extrabold text-white bg-emerald-600 hover:bg-emerald-700 shadow-xs transition-all cursor-pointer">
                <i class="fas fa-file-excel"></i>
                <span>Export Excel</span>
              </button>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 bg-slate-50/80 p-3 rounded-2xl border border-slate-200/80">
            <div>
              <label class="block text-[10px] font-extrabold uppercase tracking-wider text-slate-500 mb-1">Staff Category</label>
              <select id="official-staff-type" class="w-full p-2.5 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm font-bold text-slate-800 shadow-2xs">
                <option value="ALL">All Staff Types</option>
                ${staffTypes.map((type) => `<option value="${escapeHtml(type)}" ${officialFilters.staffType === type ? 'selected' : ''}>${escapeHtml(type)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-[10px] font-extrabold uppercase tracking-wider text-slate-500 mb-1">Account Status</label>
              <select id="official-staff-status" class="w-full p-2.5 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm font-bold text-slate-800 shadow-2xs">
                <option value="ALL">All Status</option>
                <option value="active" ${officialFilters.staffStatus === 'active' ? 'selected' : ''}>Active Only</option>
                <option value="inactive" ${officialFilters.staffStatus === 'inactive' ? 'selected' : ''}>Inactive Only</option>
              </select>
            </div>
            <div>
              <label class="block text-[10px] font-extrabold uppercase tracking-wider text-slate-500 mb-1">Search Staff</label>
              <div class="relative">
                <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                <input id="official-staff-search" type="text" value="${escapeHtml(officialFilters.staffSearch)}" class="w-full pl-8 pr-3 py-2.5 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm font-semibold text-slate-800 shadow-2xs" placeholder="Search name, role, phone, MSR...">
              </div>
            </div>
          </div>

          <!-- Staff Register Table -->
          <div class="mb-6">
            <div class="overflow-x-auto w-full rounded-xl border border-slate-200">
              <table class="w-full text-xs border-collapse min-w-[1150px]">
                <thead>
                  <tr class="bg-slate-100 text-slate-700 border-b border-slate-200">
                    <th class="border border-slate-200 px-2.5 py-2.5 w-12 text-center font-extrabold">NO</th>
                    <th class="border border-slate-200 px-2 py-2.5 w-14 text-center font-extrabold">Avatar</th>
                    <th class="border border-slate-200 px-3 py-2.5 text-left font-extrabold">Staff Name</th>
                    <th class="border border-slate-200 px-2.5 py-2.5 text-left font-extrabold">Designation / Role</th>
                    <th class="border border-slate-200 px-2.5 py-2.5 text-center font-extrabold">Category</th>
                    <th class="border border-slate-200 px-2.5 py-2.5 text-center font-extrabold">MSR / ID</th>
                    <th class="border border-slate-200 px-2.5 py-2.5 text-left font-extrabold">Phone</th>
                    <th class="border border-slate-200 px-2.5 py-2.5 text-left font-extrabold">Qualification</th>
                    <th class="border border-slate-200 px-2.5 py-2.5 text-left font-extrabold">Duty Classes</th>
                    <th class="border border-slate-200 px-2.5 py-2.5 text-left font-extrabold">Joining Date</th>
                    <th class="border border-slate-200 px-2.5 py-2.5 text-left font-extrabold">Address</th>
                    <th class="border border-slate-200 px-2.5 py-2.5 text-left font-extrabold">Access</th>
                    <th class="border border-slate-200 px-2.5 py-2.5 text-center font-extrabold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${staffTableRowsHtml || '<tr><td colspan="13" class="border border-slate-200 p-6 text-center text-slate-400 font-semibold">No staff records match the current filters.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Directory Categories -->
          ${catBlocks ? `
            <div class="space-y-4 pt-4 border-t border-slate-100">
              <h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-500 px-1">Other Directory Categories</h4>
              ${catBlocks}
            </div>` : ''}
        </div>`;

      document.getElementById('official-staff-type')?.addEventListener('change', (e) => { officialFilters.staffType = e.target.value; renderStaffTab(); });
      document.getElementById('official-staff-status')?.addEventListener('change', (e) => { officialFilters.staffStatus = e.target.value; renderStaffTab(); });
      document.getElementById('official-staff-search')?.addEventListener('input', (e) => {
        const cursorPos = e.target.selectionStart;
        officialFilters.staffSearch = e.target.value;
        renderStaffTab();
        const searchInput = document.getElementById('official-staff-search');
        if (searchInput) {
          searchInput.focus();
          try { searchInput.setSelectionRange(cursorPos, cursorPos); } catch (_err) {}
        }
      });

      document.getElementById('btn-staff-export-excel')?.addEventListener('click', () => exportStaffToExcel(filteredStaff));
      document.getElementById('btn-staff-export-pdf')?.addEventListener('click', () => printStaffDirectoryPdf(filteredStaff));

      document.querySelectorAll('[data-staff-id]').forEach((row) => row.addEventListener('click', () => {
        const staff = allStaff.find((item) => item.id === row.dataset.staffId);
        if (staff) openOfficialDetailModal('Staff Profile', buildStaffDetailHtml(staff));
      }));

      document.querySelectorAll('[data-dir-id]').forEach((row) => row.addEventListener('click', () => {
        const entry = directoryEntries.find((item) => item.id === row.dataset.dirId);
        if (entry) openOfficialDetailModal('Category Member Profile', buildDirectoryDetailHtml(entry));
      }));
    };

    const getCurrentSessionProfile = () => {
      const isStaff = userSession?.source === 'staff' || window.AppSession?.getRole?.() === 'staff' || Boolean(window.AppSession?.getStaffAccess?.());
      if (isStaff) {
        const staffEmail = normalizeText(userSession?.username || userSession?.email || window.AppSession?.getStaffEmail?.() || window.AppSession?.getStaffAccess?.()?.userKey || '');
        const staffName = normalizeText(userSession?.name || window.AppSession?.getStaffName?.() || '');
        const staffId = userSession?.id || window.AppSession?.getStaffAccess?.()?.staffId || '';
        const found = allStaff.find((staff) => (staffId && staff.id === staffId) || (staffEmail && normalizeText(staff.email) === staffEmail) || (staffEmail && normalizeText(staff.username) === staffEmail) || (staffName && normalizeText(staff.name) === staffName));
        if (found) return found;
        return userSession || {};
      }
      if (userSession?.source === 'directory') {
        const entry = directoryEntries.find((item) => item.id === userSession.id);
        if (entry) return entry;
      }
      return userSession || {};
    };
    const getAllowedPageLabels = () => {
      const perms = evaluateModulePermissions();
      const labels = [];
      if (perms.collection) labels.push('Fee Collection');
      if (perms.worksheet) labels.push('Worksheet Portal');
      if (perms.result) labels.push('Result System');
      if (perms.admin) labels.push('Admin Panel');
      return labels.length ? labels : ['Official Portal'];
    };

    const getStaffProfileEntries = (staff = {}) => {
      const seenKeys = new Set([
        'id', 'photo', 'image', 'logo', 'password', 'passwordHash', 'password_hash',
        'username', 'user_name', 'usernameRaw', 'username_raw', 'authMeta', 'source',
        'isActive', 'showInPublic', 'canCollect', 'canManageResults', 'canAccessWorksheet',
        'canAccessAdmin', 'dutyPaymentDetails', 'displayOrder', 'createdAt', 'updatedAt',
        'customValues'
      ]);
      const entries = [];
      const pushEntry = (key, label, value) => {
        if (value === undefined || value === null || String(valueToDisplay(value)).trim() === '' || valueToDisplay(value) === '--') return;
        entries.push({ key, label, value });
        seenKeys.add(key);
      };

      const cat = getDirectoryCategory(staff.type) || directoryCategories.find((c) => normalizeText(c.name) === normalizeText(staff.type));
      const catFields = normalizeConfiguredFields(cat?.fields || []);
      const customVals = (staff.customValues && typeof staff.customValues === 'object') ? staff.customValues : {};

      pushEntry('name', 'Full Name', staff.name || customVals.name);
      pushEntry('role', 'Role / Designation', staff.role || staff.designation || customVals.role || staff.type);
      pushEntry('type', 'Staff Category', cat?.name || staff.type);
      pushEntry('phone', 'Phone Number', staff.phone || staff.mobile || customVals.phone);
      if (staff.email || customVals.email) {
        pushEntry('email', 'Email Address', staff.email || customVals.email);
      }
      pushEntry('msr', 'MSR / Staff ID', staff.msr || customVals.msr);
      pushEntry('qualification', 'Qualification', staff.qualification || customVals.qualification);
      pushEntry('subject', 'Subject / Department', staff.subject || customVals.subject);
      pushEntry('joiningDate', 'Joining Date', staff.joiningDate || customVals.joiningDate);
      pushEntry('dutyClasses', 'Assigned Duty Classes', Array.isArray(staff.dutyClasses) ? staff.dutyClasses.join(', ') : (staff.dutyClasses || customVals.dutyClasses));
      pushEntry('address', 'Address', staff.address || customVals.address);

      // Include any category-configured fields
      catFields.forEach((f) => {
        if (!f.key || seenKeys.has(f.key) || f.type === 'photo' || f.type === 'password') return;
        const val = customVals[f.key] !== undefined ? customVals[f.key] : staff[f.key];
        pushEntry(f.key, f.label || toLabel(f.key), val);
      });

      // Include any remaining customValues keys added in admin
      Object.entries(customVals).forEach(([k, v]) => {
        if (seenKeys.has(k) || isSensitiveProfileField(k, k)) return;
        pushEntry(k, toLabel(k), v);
      });

      // Include any remaining top-level fields added in admin
      Object.entries(staff || {}).forEach(([k, v]) => {
        if (seenKeys.has(k) || isSensitiveProfileField(k, k) || typeof v === 'object') return;
        pushEntry(k, toLabel(k), v);
      });

      pushEntry('status', 'Account Status', staff.isActive !== false ? 'Active' : 'Inactive');
      return entries;
    };

    const getDirectoryProfileEntries = (entry = {}) => {
      const cat = getDirectoryCategory(entry?.categoryId);
      const authItem = getCategoryAuthItem(entry?.categoryId);
      const hiddenKeys = new Set([authItem.usernameField, authItem.passwordField, 'photo', 'image', 'logo'].filter(Boolean));
      const fields = normalizeConfiguredFields(cat?.fields || []).filter((f) => f.key && !hiddenKeys.has(f.key) && f.type !== 'photo' && f.type !== 'password');
      const result = [];
      const usedKeys = new Set(hiddenKeys);
      fields.forEach((f) => {
        const val = entry?.values?.[f.key];
        if (val !== undefined && val !== null && String(valueToDisplay(val)).trim() !== '' && valueToDisplay(val) !== '--') {
          result.push({ key: f.key, label: f.label || toLabel(f.key), value: val });
          usedKeys.add(f.key);
        }
      });
      Object.entries(entry?.values || {}).forEach(([k, v]) => {
        if (usedKeys.has(k) || isSensitiveProfileField(k, k)) return;
        if (v !== undefined && v !== null && String(valueToDisplay(v)).trim() !== '' && valueToDisplay(v) !== '--') {
          result.push({ key: k, label: toLabel(k), value: v });
        }
      });
      return result;
    };

    const openMyProfileModal = () => {
      const profile = getCurrentSessionProfile();
      const isDirectory = userSession?.source === 'directory';
      const label = isDirectory ? (profile.values?.name || userSession?.name || 'Staff Member') : (profile.name || userSession?.name || 'Staff Member');
      const userType = isDirectory ? (getDirectoryCategory(profile.categoryId)?.name || userSession?.type || 'Staff') : (profile.role || profile.designation || profile.type || userSession?.type || 'Staff');

      const rawPhoto = isDirectory ? (profile.values?.photo || profile.values?.image) : (profile.photo || profile.image || profile.customValues?.photo);
      const hasPhoto = Boolean(rawPhoto && typeof rawPhoto === 'string' && rawPhoto.trim() !== '' && !rawPhoto.includes('assets/images/logo.png'));

      const access = getAllowedPageLabels();
      const instName = resolveInstitutionName(institutionConfig) || 'Madrasa / Institution';
      const instReg = institutionConfig?.regNo || institutionConfig?.code || '';
      const initialChar = String(label || 'S').trim().charAt(0).toUpperCase() || 'S';

      const detailEntries = isDirectory
        ? getDirectoryProfileEntries(profile)
        : getStaffProfileEntries(profile);
      const filteredDetails = detailEntries.filter((item) => item && item.key !== 'name' && valueToDisplay(item.value) !== '--');

      const detailsRowsHtml = filteredDetails.length
        ? filteredDetails.map((item) => {
            const valStr = valueToDisplay(item.value);
            const isLong = item.key === 'address' || valStr.length > 34;
            return isLong
              ? `<div class="py-1.5 border-b border-slate-200/60 last:border-b-0">
                   <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(item.label || toLabel(item.key))}</div>
                   <div class="font-bold text-slate-800 text-xs mt-0.5 break-words whitespace-pre-line">${escapeHtml(valStr)}</div>
                 </div>`
              : `<div class="flex items-start justify-between gap-3 py-1.5 border-b border-slate-200/60 last:border-b-0 text-xs">
                   <span class="text-slate-500 font-semibold shrink-0">${escapeHtml(item.label || toLabel(item.key))}</span>
                   <span class="font-bold ${item.key === 'status' ? 'text-emerald-600 uppercase text-[11px]' : 'text-slate-800'} text-right break-all">${escapeHtml(valStr)}</span>
                 </div>`;
          }).join('')
        : `<div class="text-xs text-slate-400 text-center py-2">No additional profile details found.</div>`;

      const photoHtml = hasPhoto
        ? `<div class="relative mx-auto -mt-14 w-24 h-24 rounded-2xl p-1 bg-white shadow-xl border border-slate-200">
             <img src="${escapeHtml(rawPhoto)}" class="w-full h-full rounded-xl object-cover bg-slate-100" alt="${escapeHtml(label)}" onerror="this.onerror=null; this.parentElement.innerHTML='<div class=\\'w-full h-full rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 text-2xl font-black\\'>${escapeHtml(initialChar)}</div>';">
           </div>`
        : `<div class="relative mx-auto -mt-14 w-24 h-24 rounded-2xl p-1 bg-white shadow-xl border border-slate-200">
             <div class="w-full h-full rounded-xl bg-indigo-50 border border-indigo-100 flex flex-col items-center justify-center text-indigo-600">
               <span class="text-3xl font-black leading-none">${escapeHtml(initialChar)}</span>
             </div>
           </div>`;

      const idCardHtml = `
        <div class="w-full bg-white select-none">
          <!-- Top Lanyard Slot Cutout Bar -->
          <div class="bg-slate-900 pt-3 pb-2 px-4 flex justify-center">
            <div class="w-14 h-2 rounded-full bg-slate-800 border border-slate-700/80 shadow-inner"></div>
          </div>

          <!-- Institution Header Banner -->
          <div class="bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white px-5 pt-2.5 pb-16 text-center relative">
            <div class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-widest bg-white/10 text-emerald-300 border border-white/10 mb-1">
              <i class="fas fa-id-badge text-emerald-400"></i> Official Identity Card
            </div>
            <h4 class="text-sm sm:text-base font-black tracking-tight text-white uppercase">${escapeHtml(instName)}</h4>
            ${instReg ? `<p class="text-[10px] font-semibold text-slate-400 tracking-wider">Reg No: ${escapeHtml(instReg)}</p>` : ''}
          </div>

          <!-- Photo Container & Body Content -->
          <div class="px-5 pb-5">
            ${photoHtml}

            <!-- Identity Core -->
            <div class="text-center mt-2.5">
              <h3 class="text-lg sm:text-xl font-black text-slate-900 tracking-tight leading-tight">${escapeHtml(label)}</h3>
              <div class="mt-1">
                <span class="inline-block px-3 py-0.5 rounded-full text-[11px] font-extrabold bg-indigo-50 text-indigo-700 border border-indigo-200">
                  ${escapeHtml(userType)}
                </span>
              </div>
            </div>

            <!-- Complete Admin-Configured Details List -->
            <div class="mt-4 text-left bg-slate-50/90 px-3.5 py-2.5 rounded-2xl border border-slate-200/80 max-h-60 overflow-y-auto">
              ${detailsRowsHtml}
            </div>

            <!-- Department Access Badges -->
            <div class="mt-3.5 text-center">
              <div class="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 mb-1.5">Authorized Portal Access</div>
              <div class="flex flex-wrap gap-1.5 justify-center">
                ${access.map((item) => `
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
                    <i class="fas fa-check-circle text-emerald-500 text-[9px]"></i>
                    ${escapeHtml(item)}
                  </span>
                `).join('')}
              </div>
            </div>

            <!-- Action Buttons: Logout & Close at Bottom of ID Card -->
            <div class="mt-5 pt-3.5 border-t border-slate-100 flex items-center gap-2.5">
              <button type="button" id="official-id-card-logout-btn" class="flex-1 py-2.5 px-3 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-xl shadow-sm active:scale-95 transition-all cursor-pointer border-none flex items-center justify-center gap-1.5">
                <i class="fas fa-sign-out-alt"></i>
                <span>Logout</span>
              </button>
              <button type="button" id="official-id-card-done-btn" class="py-2.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl active:scale-95 transition-all cursor-pointer border border-slate-200">
                Close
              </button>
            </div>
          </div>
        </div>
      `;

      openIdCardModal(idCardHtml);

      document.getElementById('official-id-card-done-btn')?.addEventListener('click', closeIdCardModal);
      document.getElementById('official-id-card-logout-btn')?.addEventListener('click', () => {
        localStorage.removeItem(OFFICIAL_SESSION_KEY);
        window.AppSession?.clearAll?.();
        window.location.href = 'index.html';
      });
    };

    const renderHome = () => {
      const profile = getCurrentSessionProfile();
      const isDirectory = userSession?.source === 'directory';
      const label = isDirectory ? (profile.values?.name || userSession?.name || 'User') : (profile.name || userSession?.name || 'User');
      const rawPhoto = isDirectory
        ? (profile.values?.photo || profile.values?.image || '')
        : (profile.photo || profile.image || profile.customValues?.photo || '');
      const hasPhoto = Boolean(rawPhoto && typeof rawPhoto === 'string' && rawPhoto.trim() !== '' && !rawPhoto.includes('assets/images/logo.png'));
      const userType = isDirectory ? (getDirectoryCategory(profile.categoryId)?.name || userSession?.type || 'Category User') : (profile.type || userSession?.type || '--');
      const entries = isDirectory ? getDirectoryProfileEntries(profile) : (userSession?.source === 'staff' ? getStaffProfileEntries(profile) : renderKeyValueGrid(profile, ['photo', 'image', 'logo']));
      const detailHtml = Array.isArray(entries) ? renderEntriesGrid(entries) : entries;
      const access = getAllowedPageLabels();
      const userLineEl = document.getElementById('official-user-line');
      if (userLineEl) userLineEl.textContent = `${label}`;

      const homeTarget = document.getElementById('official-tab-home');
      if (!homeTarget) return;

      homeTarget.innerHTML = `<div class="official-me-card max-w-5xl mx-auto overflow-hidden rounded-3xl shadow-xl">
          <div class="official-me-hero p-5 sm:p-7 text-white">
            <div class="grid md:grid-cols-[180px_1fr] gap-5 items-center">
              <div class="text-center">
                ${hasPhoto ? `<img src="${escapeHtml(rawPhoto)}" onerror="this.style.display='none'; this.nextElementSibling.classList.remove('hidden');" class="official-me-photo mx-auto" alt="${escapeHtml(label)}"><div class="hidden official-me-photo mx-auto bg-white/20 border border-white/30 flex items-center justify-center text-white/50"><i class="fas fa-user text-5xl"></i></div>` : `<div class="official-me-photo mx-auto bg-white/20 border border-white/30 flex items-center justify-center text-white/50"><i class="fas fa-user text-5xl"></i></div>`}
              </div>
              <div>
                <div class="inline-flex px-3 py-1 rounded-full text-xs font-black bg-white/20 border border-white/25 backdrop-blur">Read-only Official Profile</div>
                <h3 class="text-3xl sm:text-4xl font-black mt-3 leading-tight">${escapeHtml(label)}</h3>
                <p class="text-sm sm:text-base font-bold text-white/85 mt-1">${escapeHtml(userType)}</p>
                <div class="mt-4 flex flex-wrap gap-2">${access.map((item) => `<span class="official-access-pill"><i class="fas fa-check-circle"></i>${escapeHtml(item)}</span>`).join('')}</div>
              </div>
            </div>
          </div>
          <div class="bg-white p-4 sm:p-6">
            <div class="flex items-center gap-2 mb-4"><span class="h-10 w-10 rounded-2xl bg-indigo-50 text-indigo-700 flex items-center justify-center"><i class="fas fa-id-card"></i></span><div><h4 class="font-black text-slate-900">Profile Details</h4><p class="text-xs font-bold text-slate-500">Only admin-entered profile fields are shown. Login credentials are hidden.</p></div></div>
            ${detailHtml}
          </div>
        </div>`;
    };

    const getAvailableFieldsForSource = (sourceType = builderConfig.sourceType) => {
      if (sourceType === 'alumni') {
        return [
          { id: 'SNO', label: 'Serial No. (Auto)' },
          { id: 'adm', label: 'Admission No.' },
          { id: 'name', label: 'Student Name' },
          { id: 'gender', label: 'Gender' },
          { id: 'graduatedYear', label: 'Alumni Academic Year' },
          { id: 'completedClass', label: 'Completed Class' },
          { id: 'father', label: 'Father / Guardian' },
          { id: 'mobile', label: 'Mobile Number' },
          { id: 'address', label: 'Address / Place' },
          { id: 'status', label: 'Status' },
          { id: 'CUSTOM', label: 'Custom / Blank Column' }
        ];
      }
      if (sourceType === 'staff') {
        return [
          { id: 'SNO', label: 'Serial No. (Auto)' },
          { id: 'name', label: 'Staff / Member Name' },
          { id: 'category', label: 'Category / Type' },
          { id: 'role', label: 'Designation / Role' },
          { id: 'department', label: 'Department / Subject' },
          { id: 'qualification', label: 'Qualification' },
          { id: 'mobile', label: 'Mobile Number' },
          { id: 'whatsapp', label: 'WhatsApp Number' },
          { id: 'email', label: 'Email ID' },
          { id: 'blood', label: 'Blood Group' },
          { id: 'joinDate', label: 'Joining Date' },
          { id: 'place', label: 'Place / Address' },
          { id: 'status', label: 'Status' },
          { id: 'CUSTOM', label: 'Custom / Blank Column' }
        ];
      }
      if (sourceType === 'fees') {
        return [
          { id: 'SNO', label: 'Serial No. (Auto)' },
          { id: 'adm', label: 'Admission No.' },
          { id: 'uid', label: 'UID / Roll No.' },
          { id: 'name', label: 'Student Name' },
          { id: 'class', label: 'Class' },
          { id: 'gender', label: 'Gender' },
          { id: 'father', label: 'Father Name' },
          { id: 'mobile', label: 'Mobile Number' },
          { id: 'feeTotal', label: 'Total Fee Assigned' },
          { id: 'concession', label: 'Concession / Discount' },
          { id: 'netPayable', label: 'Net Payable Fee' },
          { id: 'paidAmount', label: 'Paid Amount' },
          { id: 'balanceDue', label: 'Balance Due' },
          { id: 'feeStatus', label: 'Payment Status' },
          { id: 'lastPaymentDate', label: 'Last Payment Date' },
          { id: 'receiptNos', label: 'Receipt No(s)' },
          { id: 'CUSTOM', label: 'Custom / Blank Column' }
        ];
      }
      if (sourceType === 'results') {
        const activeExam = allExams.find((ex) => ex.id === builderConfig.examId);
        const subjectFields = Array.isArray(activeExam?.subjects)
          ? activeExam.subjects.map((sub, idx) => {
              const subName = typeof sub === 'string' ? sub : (sub?.name || sub?.title || sub?.subject || `Subject ${idx + 1}`);
              const subKey = typeof sub === 'string' ? sub : (sub?.id || sub?.code || subName);
              return { id: `SUB_${subKey}`, label: `Sub: ${subName}` };
            })
          : [];
        return [
          { id: 'SNO', label: 'Serial No. (Auto)' },
          { id: 'adm', label: 'Admission No.' },
          { id: 'uid', label: 'UID / Roll No.' },
          { id: 'name', label: 'Student Name' },
          { id: 'class', label: 'Class' },
          { id: 'gender', label: 'Gender' },
          { id: 'examName', label: 'Exam Name' },
          ...subjectFields,
          { id: 'obtainedMarks', label: 'Marks Obtained' },
          { id: 'maxMarks', label: 'Max Marks' },
          { id: 'percentage', label: 'Percentage (%)' },
          { id: 'grade', label: 'Grade' },
          { id: 'resultStatus', label: 'Pass / Fail Status' },
          { id: 'rank', label: 'Class Rank' },
          { id: 'CUSTOM', label: 'Custom / Blank Column' }
        ];
      }
      return [
        { id: 'SNO', label: 'Serial No. (Auto)' },
        { id: 'name', label: 'Student Name' },
        { id: 'adm', label: 'Admission No.' },
        { id: 'uid', label: 'UID / Roll No.' },
        { id: 'class', label: 'Class' },
        { id: 'gender', label: 'Gender' },
        { id: 'dob', label: 'Date of Birth' },
        { id: 'adm_date', label: 'Admission Date' },
        { id: 'father', label: 'Father Name' },
        { id: 'mobile', label: 'Father Mobile' },
        { id: 'mother', label: 'Mother Name' },
        { id: 'motherMobile', label: 'Mother Mobile' },
        { id: 'adhaar', label: 'Aadhaar No.' },
        { id: 'status', label: 'Status' },
        { id: 'concessionFee', label: 'Concession Fee' },
        { id: 'address', label: 'Address' },
        { id: 'CUSTOM', label: 'Custom / Blank Column' }
      ];
    };

    const getStudentsForBuilderYear = () => {
      const selectedYear = builderConfig.academicYearId || officialFilters.academicYearId || activeAcademicYearId;
      return allStudents.map((student) => filterStudentByAcademicYear(student, selectedYear)).filter(Boolean);
    };

    const buildUnifiedStaffRecords = () => {
      const combined = [];
      const seenKeys = new Set();

      allStaff.forEach((st) => {
        const name = String(st.name || '').trim();
        const cat = String(st.type || st.category || 'Staff').trim();
        const mobile = String(st.mobile || st.phone || '').trim();
        const key = `${name.toLowerCase()}|${mobile}`;
        seenKeys.add(key);
        combined.push({
          id: st.id || `staff_${combined.length}`,
          name: name || '--',
          category: cat || 'Staff',
          role: st.role || st.designation || st.position || '--',
          department: st.department || st.subject || '--',
          qualification: st.qualification || '--',
          mobile: mobile || '--',
          whatsapp: st.whatsapp || mobile || '--',
          email: st.email || '--',
          blood: st.bloodGroup || st.blood || '--',
          joinDate: st.joinDate || st.joiningDate || '--',
          place: st.place || st.address || '--',
          status: st.isActive === false ? 'Inactive' : 'Active'
        });
      });

      const catMap = new Map();
      directoryCategories.forEach((c) => {
        if (c && c.id) catMap.set(c.id, c.name || c.title || c.id);
      });

      directoryEntries.forEach((entry) => {
        const vals = entry.values || entry || {};
        const name = String(vals.name || entry.name || '').trim();
        const mobile = String(vals.mobile || vals.phone || entry.mobile || '').trim();
        const key = `${name.toLowerCase()}|${mobile}`;
        if (name && seenKeys.has(key)) return;
        if (name) seenKeys.add(key);
        const catName = catMap.get(entry.categoryId) || entry.categoryName || entry.category || vals.category || 'Management / Directory';
        combined.push({
          id: entry.id || `dir_${combined.length}`,
          name: name || '--',
          category: String(catName).trim(),
          role: vals.role || vals.designation || vals.position || entry.role || '--',
          department: vals.department || vals.subject || '--',
          qualification: vals.qualification || '--',
          mobile: mobile || '--',
          whatsapp: vals.whatsapp || mobile || '--',
          email: vals.email || entry.email || '--',
          blood: vals.blood || vals.bloodGroup || '--',
          joinDate: vals.joinDate || '--',
          place: vals.place || vals.address || '--',
          status: entry.isActive === false ? 'Inactive' : 'Active'
        });
      });

      return combined;
    };

    const computeStudentFeeRecord = (student, yearId) => {
      const cls = getStudentClass(student);
      const selectedFeeItem = builderConfig.feeItemId || 'ALL';
      const relevantFeeItems = allFeeItems.filter((item) => {
        if (item.isActive === false) return false;
        if (yearId && item.academicYear && item.academicYear !== yearId) return false;
        if (selectedFeeItem !== 'ALL' && item.id !== selectedFeeItem) return false;
        return true;
      });

      let feeTotal = 0;
      relevantFeeItems.forEach((item) => {
        const classAmt = item.classAmounts?.[cls] ?? item.amounts?.[cls] ?? item.amount ?? item.defaultAmount ?? 0;
        const parsed = parseFloat(classAmt);
        if (!isNaN(parsed) && parsed > 0) feeTotal += parsed;
      });

      const studentPayments = allPayments.filter((p) => {
        if (p.studentId !== student.id && String(p.adm || '') !== String(student.adm || '')) return false;
        if (p.isDeleted || p.status === 'cancelled') return false;
        if (yearId && p.academicYear && p.academicYear !== yearId) return false;
        if (selectedFeeItem !== 'ALL' && p.feeItemId && p.feeItemId !== selectedFeeItem) return false;
        return true;
      });

      let paidAmount = 0;
      let paymentDiscount = 0;
      const receipts = [];
      let latestDate = '';

      studentPayments.forEach((p) => {
        const amt = parseFloat(p.amount ?? p.paidAmount ?? 0) || 0;
        const disc = parseFloat(p.discount ?? 0) || 0;
        paidAmount += amt;
        paymentDiscount += disc;
        if (p.receiptNo || p.receiptNumber) receipts.push(String(p.receiptNo || p.receiptNumber));
        const pDate = p.date || p.paymentDate || '';
        if (pDate && (!latestDate || String(pDate) > String(latestDate))) latestDate = pDate;
      });

      const studentConcession = selectedFeeItem === 'ALL' ? (parseFloat(student.concessionFee || 0) || 0) : 0;
      const totalConcession = studentConcession + paymentDiscount;
      if (feeTotal === 0 && paidAmount > 0) feeTotal = paidAmount + totalConcession;

      const netPayable = Math.max(0, feeTotal - totalConcession);
      const balanceDue = Math.max(0, netPayable - paidAmount);
      let feeStatus = 'Unpaid';
      if (netPayable === 0 && paidAmount === 0) feeStatus = 'No Fee Set';
      else if (balanceDue <= 0 && (paidAmount > 0 || netPayable === 0)) feeStatus = 'Paid';
      else if (paidAmount > 0 && balanceDue > 0) feeStatus = 'Partial';

      return {
        ...student,
        class: cls,
        feeTotal: feeTotal.toFixed(0),
        concession: totalConcession.toFixed(0),
        netPayable: netPayable.toFixed(0),
        paidAmount: paidAmount.toFixed(0),
        balanceDue: balanceDue.toFixed(0),
        feeStatus,
        lastPaymentDate: latestDate ? formatDate(latestDate) : '--',
        receiptNos: receipts.length > 0 ? receipts.join(', ') : '--'
      };
    };

    const computeGradeFromPercent = (pct) => {
      if (pct >= 90) return 'A+';
      if (pct >= 80) return 'A';
      if (pct >= 70) return 'B+';
      if (pct >= 60) return 'B';
      if (pct >= 50) return 'C+';
      if (pct >= 40) return 'C';
      return 'D (Fail)';
    };

    const computeStudentResultRows = (studentsList, yearId) => {
      let targetExams = allExams.filter((ex) => !yearId || !ex.academicYear || ex.academicYear === yearId);
      if (builderConfig.examId && builderConfig.examId !== 'ALL') {
        targetExams = targetExams.filter((ex) => ex.id === builderConfig.examId);
      }
      if (targetExams.length === 0 && allExams.length > 0) {
        targetExams = builderConfig.examId !== 'ALL'
          ? allExams.filter((ex) => ex.id === builderConfig.examId)
          : [allExams[0]];
      }

      const activeExam = targetExams[0] || null;
      const examName = activeExam ? (activeExam.name || activeExam.title || activeExam.examName || 'Exam') : 'All Exams';

      const rows = studentsList.map((student) => {
        const cls = getStudentClass(student);
        let markDoc = null;
        if (activeExam) {
          markDoc = allMarks[`${activeExam.id}_${student.id}`] || allMarks[`${activeExam.id}_${student.adm}`] || null;
        }
        if (!markDoc) {
          const fallbackKey = Object.keys(allMarks).find((k) => k.endsWith(`_${student.id}`));
          if (fallbackKey) markDoc = allMarks[fallbackKey];
        }

        const subjectScores = markDoc?.marks || markDoc?.subjects || markDoc?.scores || {};
        let obtained = 0;
        let maxMarks = 0;
        const dynamicSubValues = {};

        if (Array.isArray(activeExam?.subjects) && activeExam.subjects.length > 0) {
          activeExam.subjects.forEach((sub, idx) => {
            const subName = typeof sub === 'string' ? sub : (sub?.name || sub?.title || sub?.subject || `Subject ${idx + 1}`);
            const subKey = typeof sub === 'string' ? sub : (sub?.id || sub?.code || subName);
            const subMax = parseFloat(sub?.maxMarks ?? sub?.max ?? activeExam?.maxMarksPerSubject ?? 100) || 100;
            const rawVal = subjectScores[subKey] ?? subjectScores[subName] ?? markDoc?.[subKey];
            const numVal = parseFloat(rawVal);
            if (!isNaN(numVal)) {
              obtained += numVal;
              maxMarks += subMax;
              dynamicSubValues[`SUB_${subKey}`] = String(numVal);
            } else {
              dynamicSubValues[`SUB_${subKey}`] = rawVal !== undefined && rawVal !== '' ? String(rawVal) : '--';
            }
          });
        } else if (subjectScores && typeof subjectScores === 'object') {
          Object.entries(subjectScores).forEach(([k, v]) => {
            const numVal = parseFloat(v);
            if (!isNaN(numVal)) {
              obtained += numVal;
              maxMarks += 100;
            }
            dynamicSubValues[`SUB_${k}`] = String(v ?? '--');
          });
        }

        if (markDoc?.totalMarks !== undefined || markDoc?.obtainedMarks !== undefined) {
          obtained = parseFloat(markDoc.totalMarks ?? markDoc.obtainedMarks) || obtained;
        }
        if (markDoc?.maxMarks !== undefined) {
          maxMarks = parseFloat(markDoc.maxMarks) || maxMarks;
        }

        const pct = maxMarks > 0 ? (obtained / maxMarks) * 100 : 0;
        const hasMarks = maxMarks > 0 || obtained > 0 || Object.keys(subjectScores).length > 0;

        return {
          ...student,
          class: cls,
          examName,
          ...dynamicSubValues,
          obtainedMarks: hasMarks ? obtained.toFixed(0) : '--',
          maxMarks: hasMarks && maxMarks > 0 ? maxMarks.toFixed(0) : '--',
          percentage: hasMarks && maxMarks > 0 ? `${pct.toFixed(1)}%` : '--',
          _pctNum: hasMarks ? pct : -1,
          grade: hasMarks && maxMarks > 0 ? (markDoc?.grade || computeGradeFromPercent(pct)) : '--',
          resultStatus: hasMarks ? (markDoc?.status || (pct >= 40 ? 'Passed' : 'Failed')) : 'Pending',
          rank: '--'
        };
      });

      const ranked = [...rows].filter((r) => r._pctNum >= 0).sort((a, b) => b._pctNum - a._pctNum);
      ranked.forEach((item, idx) => {
        item.rank = String(idx + 1);
      });

      return rows;
    };

    const getBuilderDatasetRows = () => {
      const yearId = builderConfig.academicYearId || officialFilters.academicYearId || activeAcademicYearId;

      if (builderConfig.sourceType === 'alumni') {
        let alumniList = allStudents.filter(isAlumniStudent);
        if (builderConfig.academicYearId && builderConfig.academicYearId !== 'ALL') {
          alumniList = alumniList.filter((s) => getAlumniGraduatedYear(s) === builderConfig.academicYearId);
        }
        let rows = alumniList.map((s) => ({
          ...s,
          class: 'Alumni',
          graduatedYear: getAlumniGraduatedYear(s),
          completedClass: s.finalClass || s.promotedFrom || 'Completed'
        }));
        if (builderConfig.sortBy === 'name') {
          rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        } else if (builderConfig.sortBy === 'adm') {
          rows.sort((a, b) => String(a.adm || '').localeCompare(String(b.adm || ''), undefined, { numeric: true }));
        } else if (builderConfig.sortBy === 'class') {
          rows.sort((a, b) => String(a.graduatedYear || '').localeCompare(String(b.graduatedYear || '')) || String(a.name || '').localeCompare(String(b.name || '')));
        }
        return rows;
      }

      if (builderConfig.sourceType === 'staff') {
        let staffRows = buildUnifiedStaffRecords();
        if (builderConfig.staffCategory && builderConfig.staffCategory !== 'ALL') {
          staffRows = staffRows.filter((s) => s.category === builderConfig.staffCategory);
        }
        if (builderConfig.sortBy === 'name') {
          staffRows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        } else if (builderConfig.sortBy === 'category') {
          staffRows.sort((a, b) => String(a.category || '').localeCompare(String(b.category || '')) || String(a.name || '').localeCompare(String(b.name || '')));
        }
        return staffRows;
      }

      const yearStudents = getStudentsForBuilderYear();
      let filteredStudents = [];
      if (!builderConfig.classId) {
        filteredStudents = [];
      } else if (builderConfig.classId === 'ALL') {
        filteredStudents = [...yearStudents];
      } else {
        filteredStudents = yearStudents.filter((s) => getStudentClass(s) === builderConfig.classId);
      }

      let rows = [];
      if (builderConfig.sourceType === 'fees') {
        rows = filteredStudents.map((s) => computeStudentFeeRecord(s, yearId));
      } else if (builderConfig.sourceType === 'results') {
        rows = computeStudentResultRows(filteredStudents, yearId);
      } else {
        rows = filteredStudents.map((s) => ({ ...s, class: getStudentClass(s) }));
      }

      if (builderConfig.sortBy === 'name') {
        rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      } else if (builderConfig.sortBy === 'adm') {
        rows.sort((a, b) => String(a.adm || '').localeCompare(String(b.adm || ''), undefined, { numeric: true }));
      } else if (builderConfig.sortBy === 'class') {
        rows.sort((a, b) => String(a.class || '').localeCompare(String(b.class || ''), undefined, { numeric: true }) || String(a.name || '').localeCompare(String(b.name || '')));
      } else if (builderConfig.sortBy === 'rank') {
        rows.sort((a, b) => (parseFloat(b.obtainedMarks) || -1) - (parseFloat(a.obtainedMarks) || -1));
      } else if (builderConfig.sortBy === 'balance') {
        rows.sort((a, b) => (parseFloat(b.balanceDue) || 0) - (parseFloat(a.balanceDue) || 0));
      }

      return rows;
    };

    const applyBuilderPreset = (presetId) => {
      saveBuilderState();
      if (presetId === 'attendance') {
        builderConfig.sourceType = 'students';
        builderConfig.customTitle = 'MONTHLY ATTENDANCE REGISTER';
        const dayCols = Array.from({ length: 12 }, (_, i) => ({
          id: `col_d${i + 1}`,
          field: 'CUSTOM',
          title: `${i + 1}`,
          width: '32px'
        }));
        builderConfig.columns = [
          { id: 'col_sno', field: 'SNO', title: 'S.No', width: '42px' },
          { id: 'col_adm', field: 'adm', title: 'Adm No', width: '75px' },
          { id: 'col_name', field: 'name', title: 'Student Name', width: '170px' },
          ...dayCols,
          { id: 'col_tot', field: 'CUSTOM', title: 'Total', width: '55px' }
        ];
      } else if (presetId === 'student_register') {
        builderConfig.sourceType = 'students';
        builderConfig.customTitle = 'GENERAL STUDENT REGISTER';
        builderConfig.columns = [
          { id: 'col_sno', field: 'SNO', title: 'S.No', width: '45px' },
          { id: 'col_adm', field: 'adm', title: 'Adm No.', width: '80px' },
          { id: 'col_uid', field: 'uid', title: 'UID', width: '80px' },
          { id: 'col_name', field: 'name', title: 'Student Name', width: '175px' },
          { id: 'col_class', field: 'class', title: 'Class', width: '65px' },
          { id: 'col_father', field: 'father', title: 'Father Name', width: '150px' },
          { id: 'col_mobile', field: 'mobile', title: 'Mobile', width: '110px' },
          { id: 'col_dob', field: 'dob', title: 'DOB', width: '95px' }
        ];
      } else if (presetId === 'fee_defaulters') {
        builderConfig.sourceType = 'fees';
        builderConfig.sortBy = 'balance';
        builderConfig.customTitle = 'FEE COLLECTION & BALANCE REGISTER';
        builderConfig.columns = [
          { id: 'col_sno', field: 'SNO', title: 'S.No', width: '45px' },
          { id: 'col_adm', field: 'adm', title: 'Adm No.', width: '80px' },
          { id: 'col_name', field: 'name', title: 'Student Name', width: '175px' },
          { id: 'col_class', field: 'class', title: 'Class', width: '65px' },
          { id: 'col_mobile', field: 'mobile', title: 'Mobile', width: '105px' },
          { id: 'col_net', field: 'netPayable', title: 'Net Fee', width: '85px' },
          { id: 'col_paid', field: 'paidAmount', title: 'Paid', width: '85px' },
          { id: 'col_bal', field: 'balanceDue', title: 'Balance Due', width: '95px' },
          { id: 'col_st', field: 'feeStatus', title: 'Status', width: '85px' }
        ];
      } else if (presetId === 'exam_marklist') {
        builderConfig.sourceType = 'results';
        builderConfig.sortBy = 'rank';
        builderConfig.customTitle = 'EXAMINATION MARK LIST & TABULATION';
        const activeExam = allExams.find((ex) => ex.id === builderConfig.examId) || allExams[0];
        if (activeExam && builderConfig.examId === 'ALL') builderConfig.examId = activeExam.id;
        const subCols = Array.isArray(activeExam?.subjects)
          ? activeExam.subjects.slice(0, 6).map((sub, i) => {
              const subName = typeof sub === 'string' ? sub : (sub?.name || sub?.title || sub?.subject || `Sub ${i + 1}`);
              const subKey = typeof sub === 'string' ? sub : (sub?.id || sub?.code || subName);
              return { id: `col_sub_${i}`, field: `SUB_${subKey}`, title: subName, width: '75px' };
            })
          : [];
        builderConfig.columns = [
          { id: 'col_sno', field: 'SNO', title: 'S.No', width: '45px' },
          { id: 'col_adm', field: 'adm', title: 'Adm No.', width: '80px' },
          { id: 'col_name', field: 'name', title: 'Student Name', width: '170px' },
          { id: 'col_class', field: 'class', title: 'Class', width: '65px' },
          ...subCols,
          { id: 'col_obt', field: 'obtainedMarks', title: 'Total', width: '75px' },
          { id: 'col_pct', field: 'percentage', title: '%', width: '68px' },
          { id: 'col_grd', field: 'grade', title: 'Grade', width: '65px' },
          { id: 'col_rnk', field: 'rank', title: 'Rank', width: '60px' }
        ];
      } else if (presetId === 'staff_register') {
        builderConfig.sourceType = 'staff';
        builderConfig.customTitle = 'STAFF & MANAGEMENT DIRECTORY REGISTER';
        builderConfig.columns = [
          { id: 'col_sno', field: 'SNO', title: 'S.No', width: '45px' },
          { id: 'col_name', field: 'name', title: 'Full Name', width: '180px' },
          { id: 'col_cat', field: 'category', title: 'Category', width: '125px' },
          { id: 'col_role', field: 'role', title: 'Designation', width: '135px' },
          { id: 'col_mob', field: 'mobile', title: 'Mobile', width: '115px' },
          { id: 'col_place', field: 'place', title: 'Place / Address', width: '140px' },
          { id: 'col_sig', field: 'CUSTOM', title: 'Signature', width: '110px' }
        ];
      } else if (presetId === 'alumni_register') {
        builderConfig.sourceType = 'alumni';
        builderConfig.customTitle = 'OFFICIAL ALUMNI REGISTER';
        builderConfig.columns = [
          { id: 'col_sno', field: 'SNO', title: 'S.No', width: '45px' },
          { id: 'col_adm', field: 'adm', title: 'Adm No.', width: '80px' },
          { id: 'col_name', field: 'name', title: 'Student Name', width: '180px' },
          { id: 'col_gen', field: 'gender', title: 'Gender', width: '70px' },
          { id: 'col_gyear', field: 'graduatedYear', title: 'Alumni Year', width: '120px' },
          { id: 'col_ccls', field: 'completedClass', title: 'Final Class', width: '90px' },
          { id: 'col_fat', field: 'father', title: 'Guardian Name', width: '150px' },
          { id: 'col_mob', field: 'mobile', title: 'Mobile', width: '110px' },
          { id: 'col_addr', field: 'address', title: 'Address / Place', width: '160px' }
        ];
      }
      renderExportTab();
      setupExcelEngine();
    };

    // Targeted DOM update for columns to preserve user edits
    const populateColumnData = (colIndex) => {
      const colConfig = builderConfig.columns[colIndex];
      if (!colConfig) return;
      const fieldId = colConfig.field;
      const dataset = getBuilderDatasetRows();
      const rowMap = new Map(dataset.map((item) => [String(item.id), item]));

      document.querySelectorAll('#builder-table tr[data-index]').forEach((tr) => {
        const recordId = tr.dataset.studentId;
        const rowIndex = parseInt(tr.dataset.index, 10);
        const cell = tr.querySelector(`.builder-cell[data-col="${colIndex}"]`);
        if (!cell) return;

        if (fieldId === 'CUSTOM') {
          cell.textContent = '';
        } else if (fieldId === 'SNO') {
          cell.textContent = recordId ? String(rowIndex + 1) : '';
        } else {
          const item = rowMap.get(String(recordId));
          cell.textContent = item ? valueToDisplay(item[fieldId]) : '';
        }
      });
    };

    const renderExportTab = () => {
      if (!builderConfig.academicYearId && (officialFilters.academicYearId || activeAcademicYearId)) {
        builderConfig.academicYearId = officialFilters.academicYearId || activeAcademicYearId;
      }

      const yearStudents = getStudentsForBuilderYear();
      const classOptions = [...new Set(yearStudents.map(getStudentClass))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const allStaffRecords = buildUnifiedStaffRecords();
      const staffCategories = [...new Set(allStaffRecords.map((s) => s.category).filter(Boolean))].sort();
      const allAlumniRecords = allStudents.filter(isAlumniStudent);
      const alumniDistinctYears = [...new Set(allAlumniRecords.map(getAlumniGraduatedYear))].sort((a, b) => {
        const [aStart = 0] = String(a).split('-').map(Number);
        const [bStart = 0] = String(b).split('-').map(Number);
        if (aStart && bStart) return bStart - aStart;
        return a.localeCompare(b);
      });
      const currentFields = getAvailableFieldsForSource(builderConfig.sourceType);
      const dataRows = getBuilderDatasetRows();

      const instName = resolveInstitutionName(institutionConfig);
      const instSub = institutionConfig.place || institutionConfig.subtitle || 'Official Academic & Administrative Register';
      const instReg = institutionConfig.regNo ? `Reg No: ${institutionConfig.regNo}` : '';

      const selectedYearObj = academicYears.find((y) => y.id === builderConfig.academicYearId);
      const yearLabel = selectedYearObj ? (selectedYearObj.name || selectedYearObj.label || selectedYearObj.id) : '';
      const autoSubInfo = [];
      if (builderConfig.sourceType === 'alumni') {
        const yearTxt = (!builderConfig.academicYearId || builderConfig.academicYearId === 'ALL') ? 'All Alumni Years' : `Alumni Year: ${builderConfig.academicYearId}`;
        autoSubInfo.push(`Alumni Cohort  •  ${yearTxt}`);
      } else if (builderConfig.sourceType !== 'staff') {
        if (yearLabel) autoSubInfo.push(`Academic Year: ${yearLabel}`);
        autoSubInfo.push(builderConfig.classId === 'ALL' ? 'All Classes' : (builderConfig.classId ? `Class: ${builderConfig.classId}` : 'Blank Sheet'));
      } else {
        autoSubInfo.push(builderConfig.staffCategory === 'ALL' ? 'All Staff & Management Categories' : `Category: ${builderConfig.staffCategory}`);
      }
      const subtitleText = builderConfig.customSubtitle || autoSubInfo.join('  •  ');

      const colSpanPrint = builderConfig.columns.length;

      const headerHtml = builderConfig.showHeader ? `
        <thead class="${builderConfig.repeatHeader ? 'builder-print-header repeat-header' : 'builder-print-header'}">
          <tr>
            <th colspan="${colSpanPrint + 1}" class="print-header-th bg-white border-0 !p-0">
              <div class="print-header-content">
                <h1 class="print-inst-name">${escapeHtml(instName)}</h1>
                <h2 class="print-inst-sub">${escapeHtml(instSub)}</h2>
                ${instReg ? `<h3 class="print-inst-reg">${escapeHtml(instReg)}</h3>` : ''}
                ${builderConfig.customTitle ? `<h4 class="print-custom-title">${escapeHtml(builderConfig.customTitle)}</h4>` : ''}
                ${subtitleText ? `<div class="text-[11px] font-bold text-slate-600 mt-1">${escapeHtml(subtitleText)}</div>` : ''}
              </div>
            </th>
          </tr>
        </thead>
      ` : '';

      const getExcelColumnLabel = (index) => {
        let label = '';
        let n = index;
        while (n >= 0) {
          label = String.fromCharCode((n % 26) + 65) + label;
          n = Math.floor(n / 26) - 1;
        }
        return label;
      };

      const excelColHeaders = builderConfig.columns.map((col, i) =>
        `<th class="no-print col-header" data-col="${i}" title="Select Column ${getExcelColumnLabel(i)}">${getExcelColumnLabel(i)}</th>`
      ).join('');

      const colHeadersHtml = builderConfig.columns.map((col, cIndex) => {
        return `<th class="builder-th group config-row-th" style="width: ${col.width || 'auto'}">
          <div class="col-resizer" data-col-index="${cIndex}"></div>
          <div class="no-print mb-1 flex items-center justify-between gap-1">
            <select class="grid-select builder-col-select" data-col-index="${cIndex}">
              ${currentFields.map((f) => `<option value="${escapeHtml(f.id)}" ${f.id === col.field ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('')}
            </select>
            <button class="text-red-500 hover:bg-red-100 px-1 py-0.5 rounded delete-col-btn opacity-0 group-hover:opacity-100 transition-opacity" data-col-index="${cIndex}" title="Remove Column"><i class="fas fa-times"></i></button>
          </div>
          <div class="no-print flex gap-1 items-center">
            <input type="text" class="grid-input builder-col-title-input" value="${escapeHtml(col.title)}" placeholder="Heading..." data-col-index="${cIndex}">
          </div>
          <div class="print-only-heading">${escapeHtml(col.title)}</div>
        </th>`;
      }).join('');

      const densityPadding = builderConfig.rowDensity === 'compact' ? '2px 5px' : (builderConfig.rowDensity === 'comfortable' ? '9px 10px' : '5px 8px');
      const defaultBorderCss = builderConfig.borderMode === 'none' ? '1px solid transparent' : '1px solid #000000';

      const renderTbodyRows = (records, startIndex = 0) => {
        const rowCount = Math.max(15, records.length);
        return Array.from({ length: rowCount }).map((_, rIndex) => {
          const rec = records[rIndex] || null;
          return `<tr data-student-id="${rec ? escapeHtml(String(rec.id)) : ''}" data-index="${startIndex + rIndex}">
            <td class="no-print row-header" data-row="${startIndex + rIndex}">${startIndex + rIndex + 1}</td>
            ${builderConfig.columns.map((col, cIndex) => {
              let cellValue = '';
              if (col.field === 'SNO') cellValue = rec ? startIndex + rIndex + 1 : '';
              else if (col.field !== 'CUSTOM' && rec) cellValue = valueToDisplay(rec[col.field]);
              const isNumField = ['SNO', 'feeTotal', 'concession', 'netPayable', 'paidAmount', 'balanceDue', 'obtainedMarks', 'maxMarks', 'rank'].includes(col.field) || String(col.field).startsWith('SUB_');
              const alignStyle = isNumField ? 'text-align: center;' : '';
              return `<td class="excel-cell builder-cell" contenteditable="true" data-row="${startIndex + rIndex}" data-col="${cIndex}" style="padding: ${densityPadding}; border: ${defaultBorderCss}; ${alignStyle}">${escapeHtml(String(cellValue))}</td>`;
            }).join('')}
          </tr>`;
        }).join('');
      };

      let bodyHtml = '';
      if (builderConfig.sourceType === 'staff' || !builderConfig.classId || builderConfig.groupBy === 'mixed') {
        bodyHtml = `<tbody>${renderTbodyRows(dataRows)}</tbody>`;
      } else if (builderConfig.groupBy === 'class_wise' && builderConfig.classId === 'ALL') {
        let runningIdx = 0;
        const groupedHtml = classOptions.map((clsName, gIdx) => {
          const clsList = dataRows.filter((r) => String(r.class || '') === clsName);
          if (clsList.length === 0) return '';
          const sectionRows = renderTbodyRows(clsList, runningIdx);
          runningIdx += Math.max(15, clsList.length);
          return `<tbody class="${gIdx > 0 ? 'page-break-before' : ''}">
            <tr>
              <td class="no-print row-header">-</td>
              <td colspan="${builderConfig.columns.length}" class="bg-slate-100 text-left text-xs py-1.5 px-3 text-slate-800 font-extrabold border border-slate-400">CLASS: ${escapeHtml(clsName)} (${clsList.length} Students)</td>
            </tr>
            ${sectionRows}
          </tbody>`;
        }).join('');
        bodyHtml = groupedHtml || `<tbody>${renderTbodyRows(dataRows)}</tbody>`;
      } else {
        const boys = dataRows.filter((s) => normalizeText(s.gender) === 'male');
        const girls = dataRows.filter((s) => normalizeText(s.gender) === 'female');

        if (builderConfig.groupBy === 'grouped') {
          bodyHtml = `<tbody>${renderTbodyRows([...boys, ...girls])}</tbody>`;
        } else if (builderConfig.groupBy === 'separate') {
          bodyHtml = `<tbody>${renderTbodyRows(boys)}</tbody>
            <tbody class="page-break-before">
              <tr>
                <td class="no-print row-header">-</td>
                <td colspan="${builderConfig.columns.length}" class="no-print bg-slate-100 text-center text-xs py-2 text-slate-500 font-bold border-dashed border-y border-slate-300">--- PAGE BREAK (Girls List) ---</td>
              </tr>
              ${renderTbodyRows(girls, Math.max(15, boys.length))}
            </tbody>`;
        } else {
          bodyHtml = `<tbody>${renderTbodyRows(dataRows)}</tbody>`;
        }
      }

      const signatureFooterHtml = builderConfig.showSignatures ? `
        <div class="mt-10 pt-8 px-6 pb-4 grid grid-cols-3 gap-8 text-center text-xs font-bold text-slate-800">
          <div class="border-t border-slate-800 pt-2">${escapeHtml(builderConfig.sigLeft || 'Class Teacher')}</div>
          <div class="border-t border-slate-800 pt-2">${escapeHtml(builderConfig.sigCenter || 'Checked By')}</div>
          <div class="border-t border-slate-800 pt-2">${escapeHtml(builderConfig.sigRight || 'Principal / Head')}</div>
        </div>
      ` : '';

      const ribbonHome = `
        <div id="ribbon-home" class="ribbon-panel ${builderConfig.activeTab === 'home' ? 'active' : ''}">
          <div class="ribbon-group">
            <div class="ribbon-row h-full">
              <button id="fmt-undo" class="excel-btn-ribbon" title="Undo"><i class="fas fa-undo"></i><span>Undo</span></button>
              <button id="fmt-redo" class="excel-btn-ribbon" title="Redo"><i class="fas fa-redo"></i><span>Redo</span></button>
            </div>
            <span class="ribbon-label">History</span>
          </div>

          <div class="ribbon-group">
            <div class="ribbon-row mb-1 gap-1">
              <select id="fmt-font-family" class="excel-input-ribbon w-28">
                <option value="'Plus Jakarta Sans', sans-serif">Jakarta Sans</option>
                <option value="Calibri, sans-serif">Calibri</option>
                <option value="Arial, sans-serif">Arial</option>
                <option value="'Times New Roman', serif">Times New Roman</option>
              </select>
              <div class="flex border border-gray-400 rounded overflow-hidden h-[24px]">
                <button id="fmt-size-minus" class="px-2 bg-white hover:bg-slate-100 border-r border-gray-400 text-[#323130]" title="Decrease Font Size"><i class="fas fa-minus text-[10px]"></i></button>
                <input type="number" id="fmt-size-input" class="w-10 text-center outline-none font-bold text-xs text-[#323130]" value="13" />
                <button id="fmt-size-plus" class="px-2 bg-white hover:bg-slate-100 border-l border-gray-400 text-[#323130]" title="Increase Font Size"><i class="fas fa-plus text-[10px]"></i></button>
              </div>
            </div>
            <div class="ribbon-row gap-0.5">
              <button id="fmt-bold" class="excel-btn-small font-serif font-bold text-[14px]" title="Bold">B</button>
              <button id="fmt-italic" class="excel-btn-small font-serif italic text-[14px]" title="Italic">I</button>
              <button id="fmt-underline" class="excel-btn-small font-serif underline text-[14px]" title="Underline">U</button>
              <div class="w-px h-4 bg-slate-300 mx-1"></div>
              <div class="relative flex items-center justify-center excel-btn-small cursor-pointer" title="Cell Fill Color">
                <i class="fas fa-fill-drip text-xs"></i>
                <div class="absolute bottom-0.5 left-1 right-1 h-[3px] bg-yellow-200 border border-gray-300 pointer-events-none indicator-bg"></div>
                <input type="color" id="fmt-bg" class="opacity-0 absolute inset-0 cursor-pointer" value="#fef08a">
              </div>
              <div class="relative flex items-center justify-center excel-btn-small cursor-pointer" title="Font Color">
                <i class="fas fa-font text-xs"></i>
                <div class="absolute bottom-0.5 left-1 right-1 h-[3px] bg-slate-900 pointer-events-none indicator-color"></div>
                <input type="color" id="fmt-color" class="opacity-0 absolute inset-0 cursor-pointer" value="#0f172a">
              </div>
              <button id="fmt-clear" class="excel-btn-small text-rose-600 ml-1" title="Clear Cell Formatting"><i class="fas fa-eraser text-xs"></i></button>
            </div>
            <span class="ribbon-label">Font</span>
          </div>

          <div class="ribbon-group">
            <div class="ribbon-row mb-1 gap-0.5">
              <button id="fmt-align-left" class="excel-btn-small" title="Align Left"><i class="fas fa-align-left text-xs"></i></button>
              <button id="fmt-align-center" class="excel-btn-small" title="Align Center"><i class="fas fa-align-center text-xs"></i></button>
              <button id="fmt-align-right" class="excel-btn-small" title="Align Right"><i class="fas fa-align-right text-xs"></i></button>
              <button id="fmt-wrap" class="excel-btn-small px-1.5 w-auto text-[11px] font-bold" title="Toggle Wrap Text"><i class="fas fa-level-down-alt rotate-90 mr-1"></i>Wrap</button>
            </div>
            <div class="ribbon-row gap-1">
              <button id="fmt-merge" class="excel-btn-small px-2 w-auto text-[11px] font-bold text-indigo-700" title="Merge Selected Cells"><i class="fas fa-object-group mr-1"></i>Merge</button>
              <button id="fmt-unmerge" class="excel-btn-small px-2 w-auto text-[11px] font-bold text-slate-700" title="Unmerge Cells"><i class="fas fa-object-ungroup mr-1"></i>Split</button>
            </div>
            <span class="ribbon-label">Alignment & Merge</span>
          </div>

          <div class="ribbon-group">
            <div class="ribbon-row mb-1 gap-1">
              <button id="fmt-border-all" class="excel-btn-small px-1.5 w-auto text-[11px] font-semibold" title="All Borders on Selected Cells"><i class="fas fa-border-all mr-1"></i>All</button>
              <button id="fmt-border-thick" class="excel-btn-small px-1.5 w-auto text-[11px] font-bold" title="Thick Box Border"><i class="fas fa-vector-square mr-1"></i>Thick</button>
              <button id="fmt-border-none" class="excel-btn-small px-1.5 w-auto text-[11px] text-slate-600" title="No Border on Selected Cells"><i class="fas fa-border-none mr-1"></i>None</button>
            </div>
            <div class="ribbon-row gap-1 items-center">
              <span class="text-[10px] font-bold text-slate-600">Table Grid:</span>
              <select id="builder-border-mode" class="excel-input-ribbon w-24">
                <option value="grid" ${builderConfig.borderMode === 'grid' ? 'selected' : ''}>Full Grid</option>
                <option value="none" ${builderConfig.borderMode === 'none' ? 'selected' : ''}>Borderless</option>
              </select>
            </div>
            <span class="ribbon-label">Borders & Lines</span>
          </div>

          <div class="ribbon-group">
            <div class="ribbon-row h-full gap-1">
              <button id="btn-add-col" class="excel-btn-ribbon text-emerald-700" title="Insert Blank Column"><i class="fas fa-columns"></i><span>+ Col</span></button>
              <button id="btn-add-row" class="excel-btn-ribbon text-emerald-700" title="Insert Blank Row"><i class="fas fa-plus-square"></i><span>+ Row</span></button>
              <button id="btn-del-row" class="excel-btn-ribbon text-rose-700" title="Delete Selected Row(s)"><i class="fas fa-trash-alt"></i><span>Del Row</span></button>
              <button id="btn-sum-row" class="excel-btn-ribbon text-indigo-700" title="Append Auto Total / Summary Row"><i class="fas fa-calculator"></i><span>Auto Total</span></button>
            </div>
            <span class="ribbon-label">Cells & Totals</span>
          </div>
        </div>
      `;

      const ribbonData = `
        <div id="ribbon-data" class="ribbon-panel ${builderConfig.activeTab === 'data' ? 'active' : ''}">
          <div class="ribbon-group">
            <div class="ribbon-row h-full items-center gap-2">
              <div class="flex flex-col">
                <label class="text-[10px] font-bold text-slate-700 mb-0.5">1. Data Module</label>
                <select id="builder-source-type" class="excel-input-ribbon w-40 font-bold text-indigo-900">
                  <option value="students" ${builderConfig.sourceType === 'students' ? 'selected' : ''}>Students Register</option>
                  <option value="alumni" ${builderConfig.sourceType === 'alumni' ? 'selected' : ''}>🎓 Alumni</option>
                  <option value="staff" ${builderConfig.sourceType === 'staff' ? 'selected' : ''}>Staff & Management</option>
                  <option value="fees" ${builderConfig.sourceType === 'fees' ? 'selected' : ''}>Fee Collection Status</option>
                  <option value="results" ${builderConfig.sourceType === 'results' ? 'selected' : ''}>Exam Results & Marks</option>
                </select>
              </div>
              ${builderConfig.sourceType === 'alumni' ? `
              <div class="flex flex-col">
                <label class="text-[10px] font-bold text-slate-700 mb-0.5">2. Alumni Year</label>
                <select id="builder-academic-year" class="excel-input-ribbon w-40 font-bold">
                  <option value="ALL" ${builderConfig.academicYearId === 'ALL' ? 'selected' : ''}>All Academic Years (${allAlumniRecords.length})</option>
                  ${alumniDistinctYears.map((yr) => `<option value="${escapeHtml(yr)}" ${builderConfig.academicYearId === yr ? 'selected' : ''}>Alumni (${escapeHtml(yr)})</option>`).join('')}
                </select>
              </div>
              ` : (builderConfig.sourceType !== 'staff' ? `
              <div class="flex flex-col">
                <label class="text-[10px] font-bold text-slate-700 mb-0.5">2. Academic Year</label>
                <select id="builder-academic-year" class="excel-input-ribbon w-32">
                  ${academicYears.length > 0
                    ? academicYears.map((y) => `<option value="${escapeHtml(y.id)}" ${builderConfig.academicYearId === y.id ? 'selected' : ''}>${escapeHtml(y.name || y.label || y.id)}${y.isActive ? ' (Active)' : ''}</option>`).join('')
                    : '<option value="">Active Year</option>'}
                </select>
              </div>
              <div class="flex flex-col">
                <label class="text-[10px] font-bold text-slate-700 mb-0.5">3. Select Class</label>
                <select id="builder-class" class="excel-input-ribbon w-36 font-bold">
                  <option value="ALL" ${builderConfig.classId === 'ALL' ? 'selected' : ''}>All Classes (${yearStudents.length})</option>
                  <option value="" ${builderConfig.classId === '' ? 'selected' : ''}>-- Blank Sheet --</option>
                  ${classOptions.map((className) => `<option value="${escapeHtml(className)}" ${builderConfig.classId === className ? 'selected' : ''}>Class ${escapeHtml(className)}</option>`).join('')}
                </select>
              </div>
              ` : `
              <div class="flex flex-col">
                <label class="text-[10px] font-bold text-slate-700 mb-0.5">2. Staff / Directory Category</label>
                <select id="builder-staff-category" class="excel-input-ribbon w-44 font-bold">
                  <option value="ALL" ${builderConfig.staffCategory === 'ALL' ? 'selected' : ''}>All Categories (${allStaffRecords.length})</option>
                  ${staffCategories.map((cat) => `<option value="${escapeHtml(cat)}" ${builderConfig.staffCategory === cat ? 'selected' : ''}>${escapeHtml(cat)}</option>`).join('')}
                </select>
              </div>
              `)}
              ${builderConfig.sourceType === 'fees' ? `
              <div class="flex flex-col">
                <label class="text-[10px] font-bold text-slate-700 mb-0.5">4. Fee Item</label>
                <select id="builder-fee-item" class="excel-input-ribbon w-36">
                  <option value="ALL" ${builderConfig.feeItemId === 'ALL' ? 'selected' : ''}>All Fee Items</option>
                  ${allFeeItems.map((fi) => `<option value="${escapeHtml(fi.id)}" ${builderConfig.feeItemId === fi.id ? 'selected' : ''}>${escapeHtml(fi.name || fi.title || fi.id)}</option>`).join('')}
                </select>
              </div>
              ` : ''}
              ${builderConfig.sourceType === 'results' ? `
              <div class="flex flex-col">
                <label class="text-[10px] font-bold text-slate-700 mb-0.5">4. Select Exam</label>
                <select id="builder-exam-id" class="excel-input-ribbon w-40">
                  <option value="ALL" ${builderConfig.examId === 'ALL' ? 'selected' : ''}>Latest / All Exams</option>
                  ${allExams.map((ex) => `<option value="${escapeHtml(ex.id)}" ${builderConfig.examId === ex.id ? 'selected' : ''}>${escapeHtml(ex.name || ex.title || ex.id)}</option>`).join('')}
                </select>
              </div>
              ` : ''}
            </div>
            <span class="ribbon-label">Data Source & Filters (${dataRows.length} Records)</span>
          </div>

          <div class="ribbon-group">
            <div class="ribbon-row h-full items-center gap-2">
              <div class="flex flex-col">
                <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Sort Order</label>
                <select id="builder-sort" class="excel-input-ribbon w-28">
                  <option value="name" ${builderConfig.sortBy === 'name' ? 'selected' : ''}>Name (A-Z)</option>
                  <option value="adm" ${builderConfig.sortBy === 'adm' ? 'selected' : ''}>Adm No.</option>
                  <option value="class" ${builderConfig.sortBy === 'class' ? 'selected' : ''}>Class Wise</option>
                  ${builderConfig.sourceType === 'results' ? `<option value="rank" ${builderConfig.sortBy === 'rank' ? 'selected' : ''}>Top Marks / Rank</option>` : ''}
                  ${builderConfig.sourceType === 'fees' ? `<option value="balance" ${builderConfig.sortBy === 'balance' ? 'selected' : ''}>Highest Balance</option>` : ''}
                  ${builderConfig.sourceType === 'staff' ? `<option value="category" ${builderConfig.sortBy === 'category' ? 'selected' : ''}>Category Wise</option>` : ''}
                </select>
              </div>
              ${builderConfig.sourceType !== 'staff' ? `
              <div class="flex flex-col">
                <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Grouping</label>
                <select id="builder-group" class="excel-input-ribbon w-32">
                  <option value="mixed" ${builderConfig.groupBy === 'mixed' ? 'selected' : ''}>Combined List</option>
                  <option value="grouped" ${builderConfig.groupBy === 'grouped' ? 'selected' : ''}>Boys First</option>
                  <option value="separate" ${builderConfig.groupBy === 'separate' ? 'selected' : ''}>Boys/Girls Page Break</option>
                  <option value="class_wise" ${builderConfig.groupBy === 'class_wise' ? 'selected' : ''}>Class-wise Page Break</option>
                </select>
              </div>
              ` : ''}
            </div>
            <span class="ribbon-label">Sort & Grouping</span>
          </div>

          <div class="ribbon-group">
            <div class="ribbon-row h-full items-center gap-1">
              <button class="excel-btn-ribbon text-indigo-700 preset-template-btn" data-preset="attendance" title="Load Monthly Attendance Grid"><i class="fas fa-calendar-check"></i><span>Attendance</span></button>
              <button class="excel-btn-ribbon text-sky-700 preset-template-btn" data-preset="student_register" title="Load Full Student Register"><i class="fas fa-user-graduate"></i><span>Student Reg</span></button>
              <button class="excel-btn-ribbon text-amber-700 preset-template-btn" data-preset="fee_defaulters" title="Load Fee Collection & Due Sheet"><i class="fas fa-rupee-sign"></i><span>Fee Sheet</span></button>
              <button class="excel-btn-ribbon text-purple-700 preset-template-btn" data-preset="exam_marklist" title="Load Exam Mark List"><i class="fas fa-award"></i><span>Mark List</span></button>
              <button class="excel-btn-ribbon text-teal-700 preset-template-btn" data-preset="staff_register" title="Load Staff & Management Register"><i class="fas fa-chalkboard-teacher"></i><span>Staff Reg</span></button>
            </div>
            <span class="ribbon-label">1-Click Smart Templates</span>
          </div>
        </div>
      `;

      const ribbonLayout = `
        <div id="ribbon-layout" class="ribbon-panel ${builderConfig.activeTab === 'layout' ? 'active' : ''}">
          <div class="ribbon-group">
            <div class="ribbon-row h-full gap-2 items-center">
              <div class="flex flex-col">
                <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Paper Size</label>
                <select id="builder-paper" class="excel-input-ribbon w-20 font-bold">
                  <option value="A4" ${builderConfig.paper === 'A4' ? 'selected' : ''}>A4</option>
                  <option value="Legal" ${builderConfig.paper === 'Legal' ? 'selected' : ''}>Legal</option>
                  <option value="A3" ${builderConfig.paper === 'A3' ? 'selected' : ''}>A3</option>
                </select>
              </div>
              <div class="flex flex-col">
                <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Orientation</label>
                <select id="builder-orient" class="excel-input-ribbon w-28 font-bold">
                  <option value="portrait" ${builderConfig.orientation === 'portrait' ? 'selected' : ''}>Portrait (Tall)</option>
                  <option value="landscape" ${builderConfig.orientation === 'landscape' ? 'selected' : ''}>Landscape (Wide)</option>
                </select>
              </div>
              <div class="flex flex-col">
                <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Row Spacing</label>
                <select id="builder-density" class="excel-input-ribbon w-24">
                  <option value="compact" ${builderConfig.rowDensity === 'compact' ? 'selected' : ''}>Compact</option>
                  <option value="normal" ${builderConfig.rowDensity === 'normal' ? 'selected' : ''}>Normal</option>
                  <option value="comfortable" ${builderConfig.rowDensity === 'comfortable' ? 'selected' : ''}>Spacious</option>
                </select>
              </div>
              <div class="flex flex-col">
                <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Canvas Zoom</label>
                <select id="builder-zoom" class="excel-input-ribbon w-20">
                  <option value="75" ${builderConfig.zoom === 75 ? 'selected' : ''}>75%</option>
                  <option value="90" ${builderConfig.zoom === 90 ? 'selected' : ''}>90%</option>
                  <option value="100" ${builderConfig.zoom === 100 ? 'selected' : ''}>100%</option>
                  <option value="115" ${builderConfig.zoom === 115 ? 'selected' : ''}>115%</option>
                </select>
              </div>
            </div>
            <span class="ribbon-label">Page Setup & Orientation</span>
          </div>

          <div class="ribbon-group">
            <div class="ribbon-row h-full gap-2 items-center">
              <div class="flex flex-col">
                <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Report Main Heading</label>
                <input type="text" id="builder-custom-title" value="${escapeHtml(builderConfig.customTitle)}" class="excel-input-ribbon w-44" placeholder="e.g. Term 1 Register">
              </div>
              <div class="flex flex-col">
                <label class="text-[10px] font-semibold text-slate-600 mb-0.5">Sub-Heading (Optional)</label>
                <input type="text" id="builder-custom-subtitle" value="${escapeHtml(builderConfig.customSubtitle)}" class="excel-input-ribbon w-40" placeholder="Auto class/year info">
              </div>
            </div>
            <span class="ribbon-label">Header Titles</span>
          </div>

          <div class="ribbon-group">
            <div class="flex flex-col gap-1 mt-0.5 justify-center h-full">
              <label class="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700 cursor-pointer">
                <input type="checkbox" id="builder-show-header" ${builderConfig.showHeader ? 'checked' : ''} class="w-3.5 h-3.5 text-emerald-600 rounded"> Show Institution Header
              </label>
              <label class="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700 cursor-pointer ${!builderConfig.showHeader ? 'opacity-50 pointer-events-none' : ''}">
                <input type="checkbox" id="builder-repeat-header" ${builderConfig.repeatHeader ? 'checked' : ''} class="w-3.5 h-3.5 text-emerald-600 rounded"> Repeat Header on Pages
              </label>
              <label class="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700 cursor-pointer">
                <input type="checkbox" id="builder-show-signatures" ${builderConfig.showSignatures ? 'checked' : ''} class="w-3.5 h-3.5 text-emerald-600 rounded"> Show Signature Footer
              </label>
            </div>
            <span class="ribbon-label">Print Options</span>
          </div>
        </div>
      `;

      const exportTarget = document.getElementById('official-tab-export');
      if (!exportTarget) return;

      exportTarget.innerHTML = `
        <div class="excel-ui-header no-print">
          <div class="excel-tabs">
            <button class="excel-tab ${builderConfig.activeTab === 'data' ? 'active' : ''}" data-ribbon="data"><i class="fas fa-database mr-1"></i>Data & Templates</button>
            <button class="excel-tab ${builderConfig.activeTab === 'home' ? 'active' : ''}" data-ribbon="home"><i class="fas fa-pen-nib mr-1"></i>Home & Formatting</button>
            <button class="excel-tab ${builderConfig.activeTab === 'layout' ? 'active' : ''}" data-ribbon="layout"><i class="fas fa-file-invoice mr-1"></i>Page Layout & Print</button>
            <div class="flex-grow"></div>
            <div class="flex gap-2 items-center pr-3 mb-1">
              <span class="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-800 border border-emerald-200 text-xs font-bold">
                <i class="fas fa-table"></i> ${dataRows.length} Rows • ${builderConfig.paper} ${builderConfig.orientation === 'landscape' ? 'Landscape' : 'Portrait'}
              </span>
              <button id="btn-export-print" class="premium-export-btn btn-pdf-red"><i class="fas fa-print"></i> Print / Save PDF</button>
              <button id="btn-export-excel" class="premium-export-btn btn-excel-green"><i class="fas fa-file-excel"></i> Export Excel</button>
            </div>
          </div>

          <div class="excel-ribbon-container">
            ${ribbonData}
            ${ribbonHome}
            ${ribbonLayout}
          </div>

          <div class="formula-bar">
            <div id="active-cell-id" class="formula-name-box">A1</div>
            <div class="formula-divider"></div>
            <div class="formula-icon">fx</div>
            <input type="text" id="formula-input" class="formula-input" placeholder="Click any cell to edit text, or drag across cells to format / merge / copy..." />
          </div>
        </div>

        <div class="excel-workspace spreadsheet-container">
          <div id="print-canvas" class="print-canvas" data-paper="${builderConfig.paper}" data-orient="${builderConfig.orientation}" style="zoom: ${(builderConfig.zoom || 100) / 100};">
            <table id="builder-table" class="excel-table">
              ${headerHtml}
              <thead>
                <tr class="no-print">
                  <th class="select-all-corner w-10 border-slate-300" title="Select All Cells"></th>
                  ${excelColHeaders}
                </tr>
                <tr class="config-row">
                  <th class="no-print row-header bg-slate-200 border-slate-300">#</th>
                  ${colHeadersHtml}
                </tr>
              </thead>
              ${bodyHtml}
            </table>
            ${signatureFooterHtml}
          </div>
        </div>
      `;

      updateCanvasStyle();
      attachBuilderListeners();
    };

    const bindColumnListeners = (thElement) => {
      const sel = thElement.querySelector('.builder-col-select');
      sel?.addEventListener('change', (e) => {
        saveBuilderState();
        const idx = parseInt(e.target.dataset.colIndex, 10);
        const fieldId = e.target.value;
        builderConfig.columns[idx].field = fieldId;
        const currentFields = getAvailableFieldsForSource(builderConfig.sourceType);
        const fieldLabel = currentFields.find((f) => f.id === fieldId)?.label || 'Column';

        const th = e.target.closest('th');
        if (fieldId !== 'CUSTOM') {
          const cleanLabel = fieldLabel.replace(/^Sub:\s*/i, '').replace(/\s*\(Auto\)$/i, '');
          builderConfig.columns[idx].title = cleanLabel;
          builderConfig.columns[idx].width = 'auto';
          th.style.width = 'auto';
          const input = th.querySelector('.builder-col-title-input');
          if (input) input.value = cleanLabel;
          const printHeading = th.querySelector('.print-only-heading');
          if (printHeading) printHeading.textContent = cleanLabel;
        } else {
          builderConfig.columns[idx].width = '130px';
          th.style.width = '130px';
        }
        populateColumnData(idx);
      });

      const titleInput = thElement.querySelector('.builder-col-title-input');
      titleInput?.addEventListener('input', (e) => {
        const idx = parseInt(e.target.dataset.colIndex, 10);
        builderConfig.columns[idx].title = e.target.value;
        const heading = e.target.closest('th').querySelector('.print-only-heading');
        if (heading) heading.textContent = e.target.value;
      });

      const delBtn = thElement.querySelector('.delete-col-btn');
      delBtn?.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.colIndex, 10);
        if (builderConfig.columns.length > 1) {
          saveBuilderState();
          builderConfig.columns.splice(idx, 1);
          renderExportTab();
          setupExcelEngine();
        }
      });
    };

    const rebindAllColumnListeners = () => {
      document.querySelectorAll('.config-row-th').forEach((th) => bindColumnListeners(th));
    };

    const syncDynamicPageOrientationStyle = () => {
      let styleEl = document.getElementById('dynamic-worksheet-page-style');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'dynamic-worksheet-page-style';
        document.head.appendChild(styleEl);
      }
      const paperSize = builderConfig.paper === 'Legal' ? 'legal' : (builderConfig.paper === 'A3' ? 'A3' : 'A4');
      const orient = builderConfig.orientation === 'landscape' ? 'landscape' : 'portrait';
      styleEl.textContent = `@media print { @page { size: ${paperSize} ${orient}; margin: 8mm; } }`;
    };

    const updateCanvasStyle = () => {
      const canvas = document.getElementById('print-canvas');
      if (canvas) {
        canvas.dataset.paper = builderConfig.paper;
        canvas.dataset.orient = builderConfig.orientation;
        canvas.style.zoom = String((builderConfig.zoom || 100) / 100);
      }
      syncDynamicPageOrientationStyle();
    };

    const attachBuilderListeners = () => {
      document.querySelectorAll('.excel-tab').forEach((tab) =>
        tab.addEventListener('click', (e) => {
          const btn = e.currentTarget;
          document.querySelectorAll('.excel-tab').forEach((t) => t.classList.remove('active'));
          document.querySelectorAll('.ribbon-panel').forEach((p) => p.classList.remove('active'));
          btn.classList.add('active');
          const targetId = btn.dataset.ribbon;
          builderConfig.activeTab = targetId;
          document.getElementById(`ribbon-${targetId}`)?.classList.add('active');
        })
      );

      document.getElementById('builder-source-type')?.addEventListener('change', (e) => {
        const newSource = e.target.value;
        builderConfig.sourceType = newSource;
        if (newSource === 'students') applyBuilderPreset('student_register');
        else if (newSource === 'alumni') applyBuilderPreset('alumni_register');
        else if (newSource === 'staff') applyBuilderPreset('staff_register');
        else if (newSource === 'fees') applyBuilderPreset('fee_defaulters');
        else if (newSource === 'results') applyBuilderPreset('exam_marklist');
      });

      document.getElementById('builder-academic-year')?.addEventListener('change', (e) => {
        builderConfig.academicYearId = e.target.value;
        renderExportTab();
        setupExcelEngine();
      });

      document.getElementById('builder-class')?.addEventListener('change', (e) => {
        builderConfig.classId = e.target.value;
        renderExportTab();
        setupExcelEngine();
      });

      document.getElementById('builder-staff-category')?.addEventListener('change', (e) => {
        builderConfig.staffCategory = e.target.value;
        renderExportTab();
        setupExcelEngine();
      });

      document.getElementById('builder-fee-item')?.addEventListener('change', (e) => {
        builderConfig.feeItemId = e.target.value;
        renderExportTab();
        setupExcelEngine();
      });

      document.getElementById('builder-exam-id')?.addEventListener('change', (e) => {
        builderConfig.examId = e.target.value;
        renderExportTab();
        setupExcelEngine();
      });

      document.getElementById('builder-sort')?.addEventListener('change', (e) => {
        builderConfig.sortBy = e.target.value;
        renderExportTab();
        setupExcelEngine();
      });

      document.getElementById('builder-group')?.addEventListener('change', (e) => {
        builderConfig.groupBy = e.target.value;
        renderExportTab();
        setupExcelEngine();
      });

      document.querySelectorAll('.preset-template-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const preset = e.currentTarget.dataset.preset;
          if (preset) applyBuilderPreset(preset);
        });
      });

      document.getElementById('builder-paper')?.addEventListener('change', (e) => {
        builderConfig.paper = e.target.value;
        updateCanvasStyle();
      });
      document.getElementById('builder-orient')?.addEventListener('change', (e) => {
        builderConfig.orientation = e.target.value;
        updateCanvasStyle();
      });
      document.getElementById('builder-density')?.addEventListener('change', (e) => {
        builderConfig.rowDensity = e.target.value;
        renderExportTab();
        setupExcelEngine();
      });
      document.getElementById('builder-zoom')?.addEventListener('change', (e) => {
        builderConfig.zoom = parseInt(e.target.value, 10) || 100;
        updateCanvasStyle();
      });
      document.getElementById('builder-border-mode')?.addEventListener('change', (e) => {
        builderConfig.borderMode = e.target.value;
        renderExportTab();
        setupExcelEngine();
      });

      document.getElementById('builder-show-header')?.addEventListener('change', (e) => {
        builderConfig.showHeader = e.target.checked;
        renderExportTab();
        setupExcelEngine();
      });
      document.getElementById('builder-repeat-header')?.addEventListener('change', (e) => {
        builderConfig.repeatHeader = e.target.checked;
        renderExportTab();
        setupExcelEngine();
      });
      document.getElementById('builder-show-signatures')?.addEventListener('change', (e) => {
        builderConfig.showSignatures = e.target.checked;
        renderExportTab();
        setupExcelEngine();
      });

      document.getElementById('builder-custom-title')?.addEventListener('input', (e) => {
        builderConfig.customTitle = e.target.value;
        const el = document.querySelector('.print-custom-title');
        if (el) el.textContent = e.target.value;
      });

      document.getElementById('builder-custom-subtitle')?.addEventListener('input', (e) => {
        builderConfig.customSubtitle = e.target.value;
      });

      rebindAllColumnListeners();

      document.getElementById('btn-add-col')?.addEventListener('click', () => {
        saveBuilderState();
        const newColIdx = builderConfig.columns.length;
        const newCol = { id: `col_${Date.now()}`, field: 'CUSTOM', title: 'Custom Col', width: '120px' };
        builderConfig.columns.push(newCol);
        renderExportTab();
        setupExcelEngine();
      });

      document.getElementById('btn-add-row')?.addEventListener('click', () => {
        saveBuilderState();
        const tbodys = document.querySelectorAll('#builder-table tbody');
        if (tbodys.length === 0) return;
        const targetTbody = tbodys[tbodys.length - 1];
        const colsCount = builderConfig.columns.length;
        const tr = document.createElement('tr');
        const nextRowIdx = document.querySelectorAll('#builder-table tr[data-index]').length;
        tr.dataset.index = nextRowIdx;
        tr.dataset.studentId = '';
        tr.innerHTML =
          `<td class="no-print row-header" data-row="${nextRowIdx}">${nextRowIdx + 1}</td>` +
          Array.from({ length: colsCount })
            .map((_, cIndex) => `<td class="excel-cell builder-cell" contenteditable="true" data-row="${nextRowIdx}" data-col="${cIndex}" style="border: 1px solid #000;"></td>`)
            .join('');
        targetTbody.appendChild(tr);
        attachTableFormatListeners();
      });

      document.getElementById('btn-del-row')?.addEventListener('click', () => {
        const selectedCells = document.querySelectorAll('.builder-cell.selected');
        if (selectedCells.length === 0) return;
        saveBuilderState();
        const rowsToDelete = new Set();
        selectedCells.forEach((td) => {
          const tr = td.closest('tr[data-index]');
          if (tr) rowsToDelete.add(tr);
        });
        rowsToDelete.forEach((tr) => tr.remove());
      });

      document.getElementById('btn-sum-row')?.addEventListener('click', () => {
        saveBuilderState();
        const tbodys = document.querySelectorAll('#builder-table tbody');
        if (tbodys.length === 0) return;
        const targetTbody = tbodys[tbodys.length - 1];
        const colsCount = builderConfig.columns.length;
        const nextRowIdx = document.querySelectorAll('#builder-table tr[data-index]').length;

        const sums = Array.from({ length: colsCount }, (_, cIndex) => {
          const colField = builderConfig.columns[cIndex]?.field;
          if (colField === 'SNO') return '';
          if (cIndex === 1 || colField === 'name') return 'TOTAL';
          let sum = 0;
          let numericCount = 0;
          document.querySelectorAll(`#builder-table .builder-cell[data-col="${cIndex}"]`).forEach((td) => {
            const raw = td.innerText.replace(/[,₹%\s]/g, '').trim();
            if (raw !== '' && !isNaN(Number(raw))) {
              sum += Number(raw);
              numericCount++;
            }
          });
          return numericCount > 0 ? sum.toFixed(sum % 1 === 0 ? 0 : 1) : '';
        });

        const tr = document.createElement('tr');
        tr.dataset.index = nextRowIdx;
        tr.dataset.studentId = '';
        tr.innerHTML =
          `<td class="no-print row-header font-bold" data-row="${nextRowIdx}">∑</td>` +
          sums
            .map(
              (val, cIndex) =>
                `<td class="excel-cell builder-cell" contenteditable="true" data-row="${nextRowIdx}" data-col="${cIndex}" style="font-weight: bold; background-color: #f1f5f9; border-top: 2px solid #000; border-bottom: 2px solid #000;">${escapeHtml(String(val))}</td>`
            )
            .join('');
        targetTbody.appendChild(tr);
        attachTableFormatListeners();
      });

      const getTargetCellsForFormat = () => {
        const selected = document.querySelectorAll('.builder-cell.selected');
        if (selected.length > 0) return Array.from(selected);
        const focused = document.activeElement?.closest?.('.builder-cell');
        return focused ? [focused] : [];
      };

      const applyFormat = (styleProp, valueFn) => {
        const cells = getTargetCellsForFormat();
        if (cells.length === 0) return;
        saveBuilderState();
        cells.forEach((td) => {
          td.style[styleProp] = typeof valueFn === 'function' ? valueFn(td.style[styleProp], td) : valueFn;
        });
      };

      const getActiveFontSize = () => parseInt(document.getElementById('fmt-size-input')?.value, 10) || 13;
      const toggleStyle = (val1, val2) => (currentVal) => (currentVal === val1 ? val2 : val1);

      document.getElementById('fmt-font-family')?.addEventListener('change', (e) => applyFormat('fontFamily', e.target.value));
      document.getElementById('fmt-bold')?.addEventListener('click', () => applyFormat('fontWeight', toggleStyle('bold', 'normal')));
      document.getElementById('fmt-italic')?.addEventListener('click', () => applyFormat('fontStyle', toggleStyle('italic', 'normal')));
      document.getElementById('fmt-underline')?.addEventListener('click', () => applyFormat('textDecoration', toggleStyle('underline', 'none')));

      document.getElementById('fmt-align-left')?.addEventListener('click', () => applyFormat('textAlign', 'left'));
      document.getElementById('fmt-align-center')?.addEventListener('click', () => applyFormat('textAlign', 'center'));
      document.getElementById('fmt-align-right')?.addEventListener('click', () => applyFormat('textAlign', 'right'));
      document.getElementById('fmt-wrap')?.addEventListener('click', () =>
        applyFormat('whiteSpace', (cur) => (cur === 'normal' ? 'nowrap' : 'normal'))
      );

      document.getElementById('fmt-border-all')?.addEventListener('click', () => applyFormat('border', '1px solid #000000'));
      document.getElementById('fmt-border-thick')?.addEventListener('click', () => applyFormat('border', '2px solid #000000'));
      document.getElementById('fmt-border-none')?.addEventListener('click', () => applyFormat('border', '1px solid transparent'));

      document.getElementById('fmt-clear')?.addEventListener('click', () => {
        const cells = getTargetCellsForFormat();
        if (cells.length === 0) return;
        saveBuilderState();
        cells.forEach((td) => {
          td.style.fontWeight = 'normal';
          td.style.fontStyle = 'normal';
          td.style.textDecoration = 'none';
          td.style.backgroundColor = '';
          td.style.color = '';
          td.style.textAlign = '';
        });
      });

      document.getElementById('fmt-merge')?.addEventListener('click', () => {
        const selected = Array.from(document.querySelectorAll('.builder-cell.selected'));
        if (selected.length < 2) return;
        saveBuilderState();
        const rows = selected.map((c) => parseInt(c.dataset.row, 10));
        const cols = selected.map((c) => parseInt(c.dataset.col, 10));
        const minR = Math.min(...rows);
        const maxR = Math.max(...rows);
        const minC = Math.min(...cols);
        const maxC = Math.max(...cols);

        const anchor = selected.find((c) => parseInt(c.dataset.row, 10) === minR && parseInt(c.dataset.col, 10) === minC);
        if (!anchor) return;

        const combinedText = selected
          .map((c) => c.innerText.trim())
          .filter(Boolean)
          .join(' ');

        anchor.rowSpan = maxR - minR + 1;
        anchor.colSpan = maxC - minC + 1;
        if (combinedText) anchor.innerText = combinedText;
        anchor.style.textAlign = 'center';
        anchor.style.verticalAlign = 'middle';

        selected.forEach((c) => {
          if (c !== anchor) c.style.display = 'none';
        });
      });

      document.getElementById('fmt-unmerge')?.addEventListener('click', () => {
        saveBuilderState();
        document.querySelectorAll('.builder-cell').forEach((c) => {
          if (c.rowSpan > 1 || c.colSpan > 1) {
            c.rowSpan = 1;
            c.colSpan = 1;
          }
          if (c.style.display === 'none') {
            c.style.display = '';
          }
        });
      });

      document.getElementById('fmt-color')?.addEventListener('input', (e) => {
        const indicator = e.target.parentElement.querySelector('.indicator-color');
        if (indicator) indicator.style.backgroundColor = e.target.value;
        applyFormat('color', e.target.value);
      });
      document.getElementById('fmt-bg')?.addEventListener('input', (e) => {
        const indicator = e.target.parentElement.querySelector('.indicator-bg');
        if (indicator) indicator.style.backgroundColor = e.target.value;
        applyFormat('backgroundColor', e.target.value);
      });

      document.getElementById('fmt-size-plus')?.addEventListener('click', () => {
        const size = getActiveFontSize() + 1;
        document.getElementById('fmt-size-input').value = size;
        applyFormat('fontSize', size + 'px');
      });
      document.getElementById('fmt-size-minus')?.addEventListener('click', () => {
        const size = Math.max(8, getActiveFontSize() - 1);
        document.getElementById('fmt-size-input').value = size;
        applyFormat('fontSize', size + 'px');
      });
      document.getElementById('fmt-size-input')?.addEventListener('change', (e) => {
        applyFormat('fontSize', e.target.value + 'px');
      });

      document.getElementById('fmt-undo')?.addEventListener('click', undoBuilder);
      document.getElementById('fmt-redo')?.addEventListener('click', redoBuilder);

      document.getElementById('btn-export-print')?.addEventListener('click', () => {
        syncDynamicPageOrientationStyle();
        document.querySelectorAll('.builder-cell, .col-header, .row-header, .select-all-corner').forEach((c) => c.classList.remove('selected'));
        document.body.classList.add('is-printing');
        window.print();
        setTimeout(() => document.body.classList.remove('is-printing'), 500);
      });

      document.getElementById('btn-export-excel')?.addEventListener('click', () => {
        if (typeof XLSX === 'undefined') return;
        const tableClone = document.getElementById('builder-table').cloneNode(true);
        tableClone.querySelectorAll('.no-print').forEach((el) => el.remove());
        tableClone.querySelectorAll('td[style*="display: none"]').forEach((el) => el.remove());
        tableClone.querySelectorAll('th').forEach((th) => {
          const heading = th.querySelector('.print-only-heading');
          if (heading) th.textContent = heading.textContent;
        });
        const wb = XLSX.utils.table_to_book(tableClone, { sheet: 'Worksheet' });
        const prefix = builderConfig.sourceType.toUpperCase();
        const sub = builderConfig.sourceType === 'staff' ? builderConfig.staffCategory : (builderConfig.classId || 'Sheet');
        XLSX.writeFile(wb, `${prefix}_${sub}_${formatDate(new Date())}.xlsx`);
      });
    };

    const attachTableFormatListeners = () => {
        const fInput = document.getElementById('formula-input');
        if(!fInput) return;
        document.querySelectorAll('.builder-cell').forEach(cell => {
            // Remove old listener to avoid duplicates if re-attaching
            const newCell = cell.cloneNode(true);
            cell.parentNode.replaceChild(newCell, cell);
            
            newCell.addEventListener('focus', (e) => {
                const row = e.target.dataset.row;
                const col = e.target.dataset.col;
                const colLetter = String.fromCharCode(65 + parseInt(col));
                document.getElementById('active-cell-id').textContent = `${colLetter}${parseInt(row)+1}`;
                fInput.value = e.target.innerText;
            });
            newCell.addEventListener('input', (e) => {
                if(e.target.classList.contains('selected')) fInput.value = e.target.innerText;
            });
        });
        
        // Ensure formula input only has one listener
        const newFInput = fInput.cloneNode(true);
        fInput.parentNode.replaceChild(newFInput, fInput);
        newFInput.addEventListener('input', (e) => {
            const activeCell = document.querySelector('.builder-cell.selected');
            if(activeCell) activeCell.innerText = e.target.value;
        });
    };

    const setupExcelEngine = () => {
        const table = document.getElementById('builder-table');
        if (!table) return;

        attachTableFormatListeners();

        let resizingCol = null;
        let startX = 0;
        let startWidth = 0;

        document.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('col-resizer')) {
                saveBuilderState();
                resizingCol = e.target.closest('th');
                startX = e.pageX;
                startWidth = resizingCol.offsetWidth;
                e.preventDefault();
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (resizingCol) {
                const newWidth = startWidth + (e.pageX - startX);
                if (newWidth > 30) {
                    resizingCol.style.width = newWidth + 'px';
                    const colIndex = resizingCol.querySelector('.col-resizer').dataset.colIndex;
                    if(builderConfig.columns[colIndex]) {
                        builderConfig.columns[colIndex].width = newWidth + 'px';
                    }
                }
            }
        });

        document.addEventListener('mouseup', () => { resizingCol = null; });

        let isSelecting = false;
        let startCell = null;

        const getCellCoords = (td) => {
            return { row: parseInt(td.dataset.row), col: parseInt(td.dataset.col) };
        };

        const clearSelection = () => document.querySelectorAll('.builder-cell, .col-header, .row-header, .select-all-corner').forEach(c => c.classList.remove('selected'));

        table.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('col-resizer')) return; 
            
            const colHeader = e.target.closest('th.col-header');
            if (colHeader) {
                clearSelection();
                colHeader.classList.add('selected');
                document.querySelectorAll(`.builder-cell[data-col="${colHeader.dataset.col}"]`).forEach(c => c.classList.add('selected'));
                return;
            }
            
            const rowHeader = e.target.closest('td.row-header');
            if (rowHeader) {
                clearSelection();
                rowHeader.classList.add('selected');
                document.querySelectorAll(`.builder-cell[data-row="${rowHeader.dataset.row}"]`).forEach(c => c.classList.add('selected'));
                return;
            }
            
            const selectAll = e.target.closest('.select-all-corner');
            if (selectAll) {
                clearSelection();
                selectAll.classList.add('selected');
                document.querySelectorAll('.builder-cell, .col-header, .row-header').forEach(c => c.classList.add('selected'));
                return;
            }

            const td = e.target.closest('td.builder-cell');
            if (td) {
                isSelecting = true;
                startCell = getCellCoords(td);
                clearSelection();
                td.classList.add('selected');
            }
        });

        table.addEventListener('mouseover', (e) => {
            if (isSelecting) {
                const td = e.target.closest('td.builder-cell');
                if (td) {
                    const endCell = getCellCoords(td);
                    const minR = Math.min(startCell.row, endCell.row);
                    const maxR = Math.max(startCell.row, endCell.row);
                    const minC = Math.min(startCell.col, endCell.col);
                    const maxC = Math.max(startCell.col, endCell.col);
                    
                    document.querySelectorAll('.builder-cell').forEach(cell => {
                        const r = parseInt(cell.dataset.row);
                        const c = parseInt(cell.dataset.col);
                        if (r >= minR && r <= maxR && c >= minC && c <= maxC) {
                            cell.classList.add('selected');
                        } else {
                            cell.classList.remove('selected');
                        }
                    });
                }
            }
        });

        document.addEventListener('mouseup', () => isSelecting = false);
        
        table.addEventListener('focusin', (e) => {
            if(e.target.classList.contains('builder-cell')) e.target.dataset.original = e.target.innerHTML;
        });
        table.addEventListener('focusout', (e) => {
            if(e.target.classList.contains('builder-cell')) {
                if(e.target.dataset.original !== e.target.innerHTML) saveBuilderState();
            }
        });

        document.addEventListener('copy', (e) => {
            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
            if (builderConfig.activeTab !== 'home' && builderConfig.activeTab !== 'data' && builderConfig.activeTab !== 'layout') return;
            const selected = document.querySelectorAll('.builder-cell.selected');
            if (selected.length === 0) return;

            const rowMap = new Map();
            selected.forEach(td => {
                const tr = td.parentElement;
                if(!rowMap.has(tr)) rowMap.set(tr, []);
                rowMap.get(tr).push(td.innerText.trim());
            });

            const tsv = Array.from(rowMap.values()).map(row => row.join('\t')).join('\n');
            e.clipboardData.setData('text/plain', tsv);
            e.preventDefault();
        });

        document.addEventListener('paste', (e) => {
            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
            if (builderConfig.activeTab !== 'home' && builderConfig.activeTab !== 'data' && builderConfig.activeTab !== 'layout') return;
            
            const activeCell = document.querySelector('.builder-cell.selected') || document.activeElement.closest('td.builder-cell');
            if (activeCell) {
                saveBuilderState();
                e.preventDefault();
                const text = e.clipboardData.getData('text/plain');
                const rowsData = text.split(/\r?\n/).map(r => r.split('\t'));
                
                const startR = parseInt(activeCell.dataset.row);
                const startC = parseInt(activeCell.dataset.col);
                
                rowsData.forEach((rowData, i) => {
                    let tr = document.querySelector(`.builder-cell[data-row="${startR + i}"]`)?.parentElement;
                    if (!tr) {
                        const targetTbody = document.querySelector('#builder-table tbody:last-child');
                        if(targetTbody) {
                            tr = document.createElement('tr');
                            const nextRowIdx = startR + i;
                            tr.dataset.index = nextRowIdx;
                            tr.dataset.studentId = ""; 
                            tr.innerHTML = `<td class="no-print row-header" data-row="${nextRowIdx}">${nextRowIdx + 1}</td>` + 
                                           Array.from({ length: builderConfig.columns.length }).map((_, cIndex) => `<td class="excel-cell builder-cell" contenteditable="true" data-row="${nextRowIdx}" data-col="${cIndex}"></td>`).join('');
                            targetTbody.appendChild(tr);
                            attachTableFormatListeners();
                        }
                    }
                    
                    if(tr) {
                        rowData.forEach((val, j) => {
                            const td = tr.querySelector(`.builder-cell[data-col="${startC + j}"]`);
                            if (td) td.textContent = val;
                        });
                    }
                });
            }
        });
    };

    const renderAll = () => {
      renderDashboard();
      buildClassSummary();
      renderStudents();
      renderAlumniTab();
      renderStaffTab();
      if(document.getElementById('official-tab-export')?.classList.contains('flex')) {
          renderExportTab();
          setupExcelEngine();
      }
    };

    const loadData = async () => {
      const [
        studentsSnap,
        staffSnap,
        groupsSnap,
        dirSnap,
        contentSnap,
        configSnap,
        authConfigSnap,
        pageAccessSnap,
        academicYearsSnap,
        feeItemsSnap,
        paymentsSnap,
        examsSnap,
        marksSnap
      ] = await Promise.all([
        getDocs(collection(db, `${BASE_PATH}/students`)),
        getDocs(collection(db, `${BASE_PATH}/staff`)),
        getDocs(collection(db, `${BASE_PATH}/studentGroups`)),
        getDocs(collection(db, `${BASE_PATH}/publicDirectory`)),
        getDoc(doc(db, `${BASE_PATH}/settings`, 'content')),
        getDoc(doc(db, `${BASE_PATH}/settings`, 'config')),
        getDoc(doc(db, `${BASE_PATH}/settings`, 'categoryAuthConfig')),
        getDoc(doc(db, `${BASE_PATH}/settings`, 'pageAccess')),
        getDoc(doc(db, `${BASE_PATH}/settings`, 'academicYears')),
        getDocs(collection(db, `${BASE_PATH}/feeItems`)).catch(() => ({ docs: [] })),
        getDocs(collection(db, `${BASE_PATH}/payments`)).catch(() => ({ docs: [] })),
        getDocs(collection(db, `${BASE_PATH}/exams`)).catch(() => ({ docs: [] })),
        getDocs(collection(db, `${BASE_PATH}/marks`)).catch(() => ({ docs: [] }))
      ]);
      allStudents = studentsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      allStaff = staffSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      studentGroups = groupsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      directoryEntries = dirSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      allFeeItems = feeItemsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      allPayments = paymentsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      allExams = examsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      allMarks = {};
      marksSnap.docs.forEach((docSnap) => {
        allMarks[docSnap.id] = docSnap.data();
      });
      const content = contentSnap.exists() ? contentSnap.data() : {};
      directoryCategories = Array.isArray(content.directoryCategories) ? content.directoryCategories : [];
      categoryAuthConfig = authConfigSnap.exists() ? { categories: {}, ...(authConfigSnap.data() || {}) } : { categories: {} };
      pageAccessConfig = pageAccessSnap.exists() ? { categories: {}, overrides: {}, ...(pageAccessSnap.data() || {}) } : { categories: {}, overrides: {} };
      const yearsData = academicYearsSnap.exists() ? (academicYearsSnap.data() || {}) : {};
      const currentYearVal = String(yearsData.currentYear || yearsData.activeYear || '').trim();
      const rawYearsList = Array.isArray(yearsData.years) ? yearsData.years : [];

      const normalizedYearMap = new Map();
      const archivedYearLabels = new Set(
        rawYearsList
          .filter((e) => typeof e === 'object' && String(e?.status || '').toLowerCase() === 'archived')
          .map((e) => String(e?.id || e?.label || e?.name || '').trim())
          .filter(Boolean)
      );

      rawYearsList.forEach((entry) => {
        if (!entry) return;
        if (typeof entry === 'string') {
          const val = entry.trim();
          if (val && !archivedYearLabels.has(val)) {
            normalizedYearMap.set(val, { id: val, name: val, label: val, isActive: val === currentYearVal });
          }
          return;
        }
        if (typeof entry === 'object') {
          if (String(entry.status || '').toLowerCase() === 'archived') {
            return;
          }
          const id = String(entry.id || entry.label || entry.value || entry.year || entry.name || '').trim();
          const name = String(entry.name || entry.label || entry.year || entry.value || id).trim();
          if (!id) return;
          const isAct = entry.isActive === true
            || (currentYearVal && (id === currentYearVal || name === currentYearVal));
          normalizedYearMap.set(id, { ...entry, id, name: name || id, label: name || id, isActive: Boolean(isAct) });
        }
      });

      if (currentYearVal && !normalizedYearMap.has(currentYearVal)) {
        normalizedYearMap.set(currentYearVal, {
          id: currentYearVal,
          name: currentYearVal,
          label: currentYearVal,
          isActive: true
        });
      }

      // Also include any academic years present directly on student records if not archived
      allStudents.forEach((stu) => {
        const directYear = String(stu?.academicYear || '').trim();
        if (directYear && !archivedYearLabels.has(directYear) && !normalizedYearMap.has(directYear)) {
          normalizedYearMap.set(directYear, {
            id: directYear,
            name: directYear,
            label: directYear,
            isActive: directYear === currentYearVal
          });
        }
        if (stu?.academicYears && typeof stu.academicYears === 'object') {
          Object.keys(stu.academicYears).forEach((yrKey) => {
            const cleanKey = String(yrKey || '').trim();
            if (cleanKey && !archivedYearLabels.has(cleanKey) && !normalizedYearMap.has(cleanKey)) {
              normalizedYearMap.set(cleanKey, {
                id: cleanKey,
                name: cleanKey,
                label: cleanKey,
                isActive: cleanKey === currentYearVal
              });
            }
          });
        }
      });

      academicYears = Array.from(normalizedYearMap.values()).sort((a, b) =>
        String(b.name || b.id).localeCompare(String(a.name || a.id), undefined, { numeric: true })
      );

      const activeYearObj = (currentYearVal && academicYears.find((y) => y.id === currentYearVal || y.name === currentYearVal))
        || academicYears.find((y) => y.isActive)
        || academicYears.find((y) => String(y.status || '').toLowerCase() === 'active')
        || academicYears[0];

      activeAcademicYearId = activeYearObj ? activeYearObj.id : currentYearVal;
      if (activeAcademicYearId) {
        academicYears.forEach((y) => {
          y.isActive = y.id === activeAcademicYearId;
        });
      }
      if (!officialFilters.academicYearId && activeAcademicYearId) {
        officialFilters.academicYearId = activeAcademicYearId;
      }
      if (!builderConfig.academicYearId && activeAcademicYearId) {
        builderConfig.academicYearId = activeAcademicYearId;
      }
      const conf = configSnap.exists() ? configSnap.data() : {};
      applyOfficialBranding(conf);
    };

    const preloadOfficialBranding = async () => {
      try {
        const configSnap = await getDoc(doc(db, `${BASE_PATH}/settings`, 'config'));
        if (!configSnap.exists()) return;
        applyOfficialBranding(configSnap.data() || {});
      } catch (_error) {}
    };

    const showApp = () => {
      document.getElementById('official-login-screen')?.classList.add('hidden');
      document.getElementById('official-app')?.classList.remove('hidden');

      const role = window.AppSession?.getRole?.() || '';
      const isStaffSession = userSession?.source === 'staff' || role === 'staff' || Boolean(window.AppSession?.getStaffAccess?.());
      const isMasterAdmin = !isStaffSession && (role === 'admin' || userSession?.source === 'firebase' || userSession?.source === 'legacy-admin' || userSession?.type === 'Admin');

      const profile = getCurrentSessionProfile() || {};
      const isDirectory = userSession?.source === 'directory';
      const resolvedName = isDirectory
        ? (profile.values?.name || userSession?.name || 'Staff Member')
        : (profile.name || userSession?.name || (isMasterAdmin ? 'Administrator' : 'Staff Member'));
      const userRole = isMasterAdmin ? 'Super Admin' : (profile.role || profile.type || userSession?.type || 'Staff');
      const rawPhoto = isDirectory
        ? (profile.values?.photo || profile.values?.image || '')
        : (profile.photo || profile.image || profile.customValues?.photo || '');
      const hasValidPhoto = Boolean(rawPhoto && typeof rawPhoto === 'string' && rawPhoto.trim() !== '' && !rawPhoto.includes('assets/images/logo.png'));

      const userLineEl = document.getElementById('official-user-line');
      if (userLineEl) userLineEl.textContent = `${resolvedName} (${userRole})`;

      const staffNameDisplay = document.getElementById('staff-name-display');
      if (staffNameDisplay) staffNameDisplay.textContent = resolvedName;
      const staffRoleDisplay = document.getElementById('staff-role-display');
      if (staffRoleDisplay) staffRoleDisplay.textContent = userRole;

      // Dropdown menu profile header card (Name on top, Role below)
      const menuUserName = document.getElementById('official-dropdown-user-name');
      if (menuUserName) menuUserName.textContent = resolvedName;
      const menuUserRole = document.getElementById('official-dropdown-user-role');
      if (menuUserRole) menuUserRole.textContent = userRole;

      const headerAvatarBox = document.getElementById('official-header-avatar-box');
      const dropdownAvatarBox = document.getElementById('official-dropdown-avatar');
      const initialChar = String(resolvedName || 'S').trim().charAt(0).toUpperCase() || 'S';
      
      if (headerAvatarBox) {
        if (hasValidPhoto) {
          headerAvatarBox.innerHTML = `<img src="${escapeHtml(rawPhoto)}" alt="${escapeHtml(resolvedName)}" class="w-full h-full object-cover rounded-full" onerror="this.onerror=null;this.parentElement.innerHTML='<span class=\\'text-xs font-extrabold text-indigo-700\\'>${escapeHtml(initialChar)}</span>';">`;
        } else {
          headerAvatarBox.innerHTML = `<span class="text-xs font-extrabold text-indigo-700">${escapeHtml(initialChar)}</span>`;
        }
      }

      if (dropdownAvatarBox) {
        if (hasValidPhoto) {
          dropdownAvatarBox.innerHTML = `<img src="${escapeHtml(rawPhoto)}" alt="${escapeHtml(resolvedName)}" class="w-full h-full object-cover rounded-full" onerror="this.onerror=null;this.parentElement.innerHTML='<span class=\\'text-xs font-black text-indigo-700\\'>${escapeHtml(initialChar)}</span>';">`;
        } else {
          dropdownAvatarBox.innerHTML = `<span class="text-xs font-black text-indigo-700">${escapeHtml(initialChar)}</span>`;
        }
      }

      renderAll();

      onSnapshot(doc(db, `${BASE_PATH}/settings`, 'academicYears'), (snap) => {
        if (!snap.exists()) return;
        const yearsData = snap.data() || {};
        const newCurrentYearVal = String(yearsData.currentYear || yearsData.activeYear || '').trim();
        if (newCurrentYearVal && newCurrentYearVal !== activeAcademicYearId) {
          activeAcademicYearId = newCurrentYearVal;
          officialFilters.academicYearId = newCurrentYearVal;
          builderConfig.academicYearId = newCurrentYearVal;
          academicYears.forEach((y) => {
            y.isActive = (y.id === activeAcademicYearId || y.name === activeAcademicYearId || y.label === activeAcademicYearId);
          });
          renderAll();
        }
      });
      if (isWorksheetPage) {
        const rawHash = (window.location.hash || '').replace('#', '');
        const validTabs = ['summary', 'students', 'staff', 'export'];
        setTab(validTabs.includes(rawHash) ? rawHash : 'summary');
      } else {
        setTab('dashboard');
        const navProfileBtn = document.getElementById('official-nav-profile-btn');
        if (navProfileBtn && !navProfileBtn.dataset.boundProfileModal) {
          navProfileBtn.dataset.boundProfileModal = 'true';
          navProfileBtn.addEventListener('click', () => {
            setMobileMenuState(false);
            openMyProfileModal();
          });
        }
        officialPwa?.showPopupIfEligible();
      }
    };

    onAuthStateChanged(auth, async (user) => {
      if (!user) await signInAnonymously(auth);
      authReady = true;
    });

    document.querySelectorAll('#official-logout-btn, .official-logout-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        localStorage.removeItem(OFFICIAL_SESSION_KEY);
        window.AppSession?.clearAll?.();
        window.location.href = 'index.html';
      });
    });

    const restoreOfficialSession = async () => {
      let hasValidSession = false;
      try {
        if (window.AppSession && window.AppSession.isFresh()) {
          const role = window.AppSession.getRole();
          if (role === 'admin' || role === 'staff') {
            const stateKey = role === 'admin' ? 'app_session_admin_state' : 'app_session_staff_state';
            const rawState = localStorage.getItem(stateKey);
            const state = rawState ? JSON.parse(rawState) : {};

            const isStaffState = role === 'staff' || Boolean(state.access) || state.access?.source === 'staff';
            userSession = {
              name: state.name || (isStaffState ? 'Staff' : 'Super Admin'),
              username: state.email || (isStaffState ? (state.userKey || 'staff') : 'admin'),
              type: isStaffState ? (state.access?.type || 'Staff') : 'Admin',
              role: isStaffState ? (state.access?.role || 'Staff') : 'Super Admin',
              source: isStaffState ? 'staff' : 'firebase',
              access: state.access || null,
              id: state.access?.staffId || state.id || '',
              phone: state.access?.phone || '',
              photo: state.access?.photo || '',
              actLikeSuperAdmin: state.access?.actLikeSuperAdmin === true
            };
            hasValidSession = true;
          }
        }
      } catch (_sessionErr) {
        hasValidSession = false;
      }

      if (!hasValidSession) {
        // Direct link access without valid session from index.html must return to index.html
        window.location.replace('index.html');
        return;
      }

      try {
        await loadData();
        if (isWorksheetPage) {
          const perms = evaluateModulePermissions();
          if (!perms.worksheet) {
            window.location.replace('official.html');
            return;
          }
        }
        showApp();
      } catch (renderError) {
        console.error('Official portal data/render error:', renderError);
        try {
          showApp();
        } catch (_fallbackErr) {}
      }
    };

    preloadOfficialBranding();
    restoreOfficialSession();
