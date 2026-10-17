import { signOut, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { doc, onSnapshot, collection, getDocs, writeBatch, setDoc, query, where, getDoc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, auth } from '../../config/firebase-config.js';
import { ADMIN_AUTH_DOC_ID, SINGLE_ADMIN_MODE, STAFF_ACCESS_COLLECTION } from '../../config/app-config.js';
import { BASE_PATH, applyInstitutionBranding, escapeHtml } from '../shared/app-common.js';
import { showToast } from '../shared/toaster.js';

// --- Global Variables ---
let isCurrentAdmin = false;
let hasResultAccess = false;
let currentUserKey = ''; // Holds loginId (Username) or email
let currentStaffDoc = null;
let teacherAssignedClasses = [];

let students = [];
let classes = [];
let resultSchemas = [];
let examResultsCache = [];
let resultCenterSettings = { publishAt: '', examLabel: '', locked: false };
let institutionConfig = {};
let currentAcademicYear = '';
let availableAcademicYears = [];
let allStaff = [];
let currentDraftFilter = 'all';
let currentPublishedFilter = 'all';
let viewingResultId = '';
window.addEventListener('load', () => {
    const loader = document.getElementById('loading-screen');
    if (!loader) return;
    loader.style.opacity = '0';
    setTimeout(() => { loader.style.display = 'none'; }, 300);
});

const getStaffAssignedClasses = (staffDoc = null, staffAccess = null) => {
    const classesSet = new Set();
    const addIfClass = (val) => {
        if (!val) return;
        if (Array.isArray(val)) {
            val.forEach((v) => addIfClass(v));
            return;
        }
        const str = String(val).trim();
        if (!str) return;
        if (str.includes(',')) {
            str.split(',').forEach((s) => addIfClass(s));
            return;
        }
        if (str.includes('/')) {
            str.split('/').forEach((s) => addIfClass(s));
            return;
        }
        classesSet.add(str);
    };

    if (staffDoc) {
        addIfClass(staffDoc.assignedClass);
        addIfClass(staffDoc.assignedClasses);
        addIfClass(staffDoc.class);
        addIfClass(staffDoc.classes);
        if (staffDoc.customFields) {
            addIfClass(staffDoc.customFields.assignedClass);
            addIfClass(staffDoc.customFields.assignedClasses);
            addIfClass(staffDoc.customFields.class);
            addIfClass(staffDoc.customFields.classes);
        }
        if (staffDoc.role) {
            const match = String(staffDoc.role).match(/class\s*([0-9a-zA-Z\s-]+)/i);
            if (match && match[1]) addIfClass(match[1].trim());
        }
    }

    if (staffAccess) {
        addIfClass(staffAccess.assignedClass);
        addIfClass(staffAccess.assignedClasses);
        addIfClass(staffAccess.class);
        addIfClass(staffAccess.classes);
    }

    return Array.from(classesSet);
};

let editingExamId = null;
let roleScope = 'staff';
let resultPageFatalError = false;
const reportFatalResultError = (error, context = 'runtime') => {
    console.error(`Result page fatal error (${context})`, error);
    resultPageFatalError = true;
    const fatalEl = document.getElementById('result-fatal-error');
    const loader = document.getElementById('loading-screen');
    if (loader) loader.style.display = 'none';
    if (fatalEl) fatalEl.classList.remove('hidden');
};
const withSafeUi = (fn, context = 'ui') => (...args) => {
    try { return fn(...args); } catch (error) { reportFatalResultError(error, context); return null; }
};
const debounce = (fn, wait = 120) => {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
};
const normalizeEmail = (value = '') => String(value || '').trim().toLowerCase();
const normalizeSchemaSubjects = (subjects = []) => {
    if (!Array.isArray(subjects)) return [];
    return subjects
        .map((entry) => (typeof entry === 'string' ? entry.trim() : String(entry?.name || '').trim()))
        .filter(Boolean);
};
const normalizeResultSchema = (schema = {}) => ({
    ...schema,
    subjects: normalizeSchemaSubjects(schema.subjects || [])
});
const normalizeSubjectRow = (row = {}, index = 0) => {
    const name = String(row?.name || '').trim();
    if (!name) return null;
    const maxMarks = Number(row?.maxMarks ?? row?.totalMarks ?? row?.max ?? 100);
    const passMarks = Number(row?.passMarks ?? row?.pass ?? 35);
    return {
        id: String(row?.id || name || `subject_${index + 1}`).trim().replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || `subject_${index + 1}`,
        name,
        maxMarks: Number.isFinite(maxMarks) && maxMarks > 0 ? maxMarks : 100,
        passMarks: Number.isFinite(passMarks) && passMarks >= 0 ? passMarks : 0
    };
};
const getSchemaSubjectRows = (schema = {}, examKey = '') => {
    const subjectRows = Array.isArray(schema.subjectRows) && schema.subjectRows.length
        ? schema.subjectRows.map((row, index) => normalizeSubjectRow(row, index)).filter(Boolean)
        : normalizeSchemaSubjects(schema.subjects || []).map((name, index) => normalizeSubjectRow({ name, maxMarks: schema.maxMarks || 100, passMarks: schema.passMarks || 35 }, index)).filter(Boolean);
    if (!examKey || !schema.examConfigs?.[examKey]?.subjects?.length) return subjectRows;
    const allowed = new Set(schema.examConfigs[examKey].subjects.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
    return subjectRows.filter((subject) => allowed.has(subject.id.toLowerCase()) || allowed.has(subject.name.toLowerCase()));
};
const makeExamKey = (label = '') => String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `exam_${Date.now()}`;
const DEFAULT_EXAM_DEFS = [
    { key: 'quarterly', label: 'Quarterly' },
    { key: 'halfYearly', label: 'Half-Yearly' },
    { key: 'annual', label: 'Annual' }
];
const isDefaultExamKey = (key = '') => DEFAULT_EXAM_DEFS.some((exam) => exam.key === key);
const getCustomExamConfigs = (configs = {}) => Object.fromEntries(Object.entries(configs || {}).filter(([key, config]) => !isDefaultExamKey(key) && config?.disabled !== true));
const makeExamValue = (schemaId = '', examKey = '') => `${schemaId}::${examKey}`;
const parseExamValue = (value = '') => {
    const [schemaId, examKey] = String(value || '').split('::');
    return { schemaId: schemaId || '', examKey: examKey || '' };
};
const getSchemaForClass = (year = currentAcademicYear, classLabel = '') => resultSchemas.find((schema) => schema.classLabel === classLabel && (!year || schema.academicYear === year || !schema.academicYear));
const getExamOptionsForClass = (classLabel = '', year = currentAcademicYear) => {
    const schema = getSchemaForClass(year, classLabel);
    if (!schema) return [];
    const configs = schema.examConfigs || {};
    const defaults = DEFAULT_EXAM_DEFS.map((exam) => ({
        value: makeExamValue(schema.id, exam.key),
        key: exam.key,
        label: exam.label,
        schema,
        config: { label: exam.label, subjects: [], isDefault: true },
        isDefault: true
    }));
    const custom = Object.entries(configs)
        .filter(([key, config]) => !DEFAULT_EXAM_DEFS.some((exam) => exam.key === key) && config?.disabled !== true)
        .map(([key, config]) => ({
            value: makeExamValue(schema.id, key),
            key,
            label: config?.label || key,
            schema,
            config,
            isDefault: false
        }));
    return [...defaults, ...custom];
};
const getExamContext = (value = '', classLabel = '', year = currentAcademicYear) => {
    const { schemaId, examKey } = parseExamValue(value);
    const schema = resultSchemas.find((item) => item.id === schemaId) || getSchemaForClass(year, classLabel) || resultSchemas.find((item) => item.id === value);
    if (!schema) return null;
    const options = getExamOptionsForClass(schema.classLabel || classLabel, year);
    const option = options.find((entry) => entry.value === value || entry.key === examKey);
    return option || { value: schema.id, key: schema.id, label: schema.name || schema.classLabel || schema.id, schema };
};
const resolveResultAccess = async ({ isAdminUser = false, staffDocs = [], user = null, staffAccess = null, userKey = '' } = {}) => {
    const isSuperOrAdmin = isAdminUser || staffAccess?.actLikeSuperAdmin === true || staffAccess?.canAccessAdmin === true || staffAccess?.admin === true;
    if (isSuperOrAdmin) {
        const matchingDoc = staffDocs.find((s) => {
            const sId = s.id;
            const sLoginId = String(s.loginId || s.username || '').trim().toLowerCase();
            const sEmail = String(s.email || '').trim().toLowerCase();
            const sName = String(s.name || '').trim().toLowerCase();
            return (staffAccess?.staffId && sId === staffAccess.staffId)
                || (userKey && (sLoginId === userKey || sEmail === userKey || sName === userKey));
        });
        return {
            allowed: true,
            isAdmin: true,
            label: matchingDoc?.name || staffAccess?.name || staffAccess?.displayName || user?.displayName || 'ADMINISTRATOR',
            staffDoc: matchingDoc || null
        };
    }

    const myStaffDoc = staffDocs.find((s) => {
        const sId = s.id;
        const sLoginId = String(s.loginId || s.username || '').trim().toLowerCase();
        const sEmail = String(s.email || '').trim().toLowerCase();
        const sName = String(s.name || '').trim().toLowerCase();
        return (staffAccess?.staffId && sId === staffAccess.staffId)
            || (userKey && (sLoginId === userKey || sEmail === userKey || sName === userKey));
    });
    let hasResultPermission = myStaffDoc && myStaffDoc.isActive !== false && (
        myStaffDoc.canManageResults === true
        || myStaffDoc.canAccessAdmin === true
        || myStaffDoc.actLikeSuperAdmin === true
        || staffAccess?.result === true
        || staffAccess?.canManageResults === true
        || staffAccess?.canAccessAdmin === true
        || staffAccess?.actLikeSuperAdmin === true
    );
    if (!hasResultPermission) {
        const staffAccessRef = doc(db, STAFF_ACCESS_COLLECTION, normalizeEmail(user?.email || staffAccess?.email || staffAccess?.userKey || ''));
        const staffAccessSnap = await getDoc(staffAccessRef);
        if (staffAccessSnap.exists()) {
            const accessData = staffAccessSnap.data() || {};
            hasResultPermission = accessData.isActive !== false && (
                accessData.result === true || accessData.canManageResults === true || accessData.canAccessAdmin === true || accessData.actLikeSuperAdmin === true
            );
        }
    }
    if (!hasResultPermission) return { allowed: false, label: '', staffDoc: null };
    return {
        allowed: true,
        isAdmin: false,
        label: myStaffDoc?.name || staffAccess?.name || staffAccess?.displayName || user?.displayName || 'RESULT OPERATOR',
        staffDoc: myStaffDoc || null
    };
};
const resultMatchesExam = (row = {}, value = '') => {
    if (!value) return true;
    if (row.examKey === value || row.examType === value) return true;
    if (row.examId === value) return true;
    const { schemaId, examKey } = parseExamValue(value);
    if (examKey && (row.examKey === examKey || row.examType === examKey)) {
        if (!schemaId || schemaId === '__all' || row.schemaId === schemaId || !row.schemaId) {
            return true;
        }
    }
    if (schemaId && schemaId !== '__all' && (row.schemaId === schemaId || row.examId === schemaId)) {
        if (!examKey || row.examKey === examKey) return true;
    }
    const rowExamId = String(row.examId || '');
    if (rowExamId.endsWith(`::${value}`) || rowExamId.endsWith(`_${value}`)) return true;
    return false;
};
export const showAppConfirm = ({
    title = 'Confirm Action',
    message = 'Are you sure you want to proceed?',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    type = 'danger'
} = {}) => {
    return new Promise((resolve) => {
        const modal = document.getElementById('app-confirm-modal');
        const titleEl = document.getElementById('app-confirm-title');
        const msgEl = document.getElementById('app-confirm-message');
        const actionBtn = document.getElementById('app-confirm-action-btn');
        const actionLabel = document.getElementById('app-confirm-action-label');
        const cancelBtn = document.getElementById('app-confirm-cancel-btn');
        const iconContainer = document.getElementById('app-confirm-icon-container');
        const iconEl = document.getElementById('app-confirm-icon');

        if (!modal) {
            resolve(window.confirm(message));
            return;
        }

        if (titleEl) titleEl.textContent = title;
        if (msgEl) msgEl.textContent = message;
        if (actionLabel) actionLabel.textContent = confirmText;
        if (cancelBtn) cancelBtn.textContent = cancelText;

        if (iconContainer && iconEl && actionBtn) {
            if (type === 'danger') {
                iconContainer.className = 'w-14 h-14 mx-auto rounded-full flex items-center justify-center text-2xl mb-4 bg-red-100 text-red-600';
                iconEl.className = 'fas fa-trash-alt';
                actionBtn.className = 'w-1/2 sm:w-auto px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-xs shadow-md transition flex items-center justify-center gap-1.5 cursor-pointer';
            } else if (type === 'warning') {
                iconContainer.className = 'w-14 h-14 mx-auto rounded-full flex items-center justify-center text-2xl mb-4 bg-amber-100 text-amber-600';
                iconEl.className = 'fas fa-triangle-exclamation';
                actionBtn.className = 'w-1/2 sm:w-auto px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-md transition flex items-center justify-center gap-1.5 cursor-pointer';
            } else {
                iconContainer.className = 'w-14 h-14 mx-auto rounded-full flex items-center justify-center text-2xl mb-4 bg-indigo-100 text-indigo-600';
                iconEl.className = 'fas fa-question-circle';
                actionBtn.className = 'w-1/2 sm:w-auto px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-md transition flex items-center justify-center gap-1.5 cursor-pointer';
            }
        }

        modal.classList.remove('hidden');
        modal.style.display = 'flex';
        document.body.classList.add('modal-scroll-lock');

        const cleanUp = (result) => {
            modal.classList.add('hidden');
            modal.style.display = 'none';
            document.body.classList.remove('modal-scroll-lock');
            if (actionBtn) actionBtn.onclick = null;
            if (cancelBtn) cancelBtn.onclick = null;
            resolve(result);
        };

        if (actionBtn) actionBtn.onclick = () => cleanUp(true);
        if (cancelBtn) cancelBtn.onclick = () => cleanUp(false);
    });
};

export const showAppAlert = ({
    title = 'Notice',
    message = '',
    type = 'info'
} = {}) => {
    return new Promise((resolve) => {
        const modal = document.getElementById('app-alert-modal');
        const titleEl = document.getElementById('app-alert-title');
        const msgEl = document.getElementById('app-alert-message');
        const okBtn = document.getElementById('app-alert-ok-btn');
        const iconContainer = document.getElementById('app-alert-icon-container');
        const iconEl = document.getElementById('app-alert-icon');

        if (!modal) {
            window.alert(message);
            resolve();
            return;
        }

        if (titleEl) titleEl.textContent = title;
        if (msgEl) msgEl.textContent = message;

        if (iconContainer && iconEl && okBtn) {
            if (type === 'success') {
                iconContainer.className = 'w-14 h-14 mx-auto rounded-full flex items-center justify-center text-2xl mb-4 bg-emerald-100 text-emerald-600';
                iconEl.className = 'fas fa-circle-check';
                okBtn.className = 'w-full sm:w-auto px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md transition cursor-pointer';
            } else if (type === 'error') {
                iconContainer.className = 'w-14 h-14 mx-auto rounded-full flex items-center justify-center text-2xl mb-4 bg-red-100 text-red-600';
                iconEl.className = 'fas fa-circle-xmark';
                okBtn.className = 'w-full sm:w-auto px-6 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-xs shadow-md transition cursor-pointer';
            } else if (type === 'warning') {
                iconContainer.className = 'w-14 h-14 mx-auto rounded-full flex items-center justify-center text-2xl mb-4 bg-amber-100 text-amber-600';
                iconEl.className = 'fas fa-triangle-exclamation';
                okBtn.className = 'w-full sm:w-auto px-6 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-md transition cursor-pointer';
            } else {
                iconContainer.className = 'w-14 h-14 mx-auto rounded-full flex items-center justify-center text-2xl mb-4 bg-indigo-100 text-indigo-600';
                iconEl.className = 'fas fa-circle-info';
                okBtn.className = 'w-full sm:w-auto px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-md transition cursor-pointer';
            }
        }

        modal.classList.remove('hidden');
        modal.style.display = 'flex';
        document.body.classList.add('modal-scroll-lock');

        const keyHandler = (e) => {
            if (e.key === 'Escape' || e.key === 'Enter') {
                e.preventDefault();
                cleanUp();
            }
        };

        const cleanUp = () => {
            modal.classList.add('hidden');
            modal.style.display = 'none';
            document.body.classList.remove('modal-scroll-lock');
            if (okBtn) okBtn.onclick = null;
            document.removeEventListener('keydown', keyHandler);
            resolve();
        };

        if (okBtn) okBtn.onclick = () => cleanUp();
        document.addEventListener('keydown', keyHandler);
    });
};

const notify = (message = '', type = 'info') => {
    if (!message) return;
    showToast(message, type);
};

const alert = (message) => {
    if (!message) return;
    const msg = String(message);
    const isError = /error|fail|invalid|stopped|required|select|cannot|choose/i.test(msg);
    const isSuccess = /success|completed|saved|synced|restored|uploaded|published/i.test(msg);
    if (isSuccess && !isError) {
        notify(msg, 'success');
        return;
    }
    const type = isError ? 'error' : 'info';
    const title = isError ? 'Attention' : 'Notice';
    showAppAlert({ title, message: msg, type });
};
const withBusyButton = async (buttonId, labelBusy, runner) => {
    const btn = document.getElementById(buttonId);
    const old = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = labelBusy;
    }
    try {
        await runner();
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = old;
        }
    }
};
const getNextClassLabel = (classLabel = '') => {
    const progressionMap = resultCenterSettings.classProgressionMap || {};
    if (progressionMap[classLabel] !== undefined && progressionMap[classLabel] !== null && String(progressionMap[classLabel]).trim() !== '') {
        return String(progressionMap[classLabel]).trim();
    }
    const clean = String(classLabel || '').trim();
    if (clean.toLowerCase() === 'alumni') return '';
    const match = clean.match(/^(\d+)(\s*[A-Z])?$/i);
    if (!match) return 'Alumni';
    const num = Number(match[1]);
    if (!Number.isFinite(num) || num <= 0) return 'Alumni';
    if (num >= 10) return 'Alumni';
    return `${num + 1}${match[2] || ''}`.trim();
};
const detectAnnualResultRow = (row = {}) => {
    if (String(row.examType || '').toLowerCase() === 'annual') return true;
    const examName = String(resultSchemas.find((schema) => schema.id === row.examId)?.name || '').toLowerCase();
    return examName.includes('annual');
};
const getStoredMarkValue = (mark) => {
    if (mark && typeof mark === 'object') return String(mark.value ?? mark.mark ?? '').trim();
    return String(mark ?? '').trim();
};
const getResultMark = (marks = {}, subject = {}) => {
    const mark = marks[subject.id] ?? marks[subject.name] ?? '';
    return getStoredMarkValue(mark);
};
const isPassingMark = (value = '', passMarks = 35) => {
    const raw = String(value ?? '').trim().toUpperCase();
    if (!raw) return false;
    if (raw === 'P') return true;
    if (raw === 'A' || raw === 'AB') return false;
    const num = Number(raw);
    return Number.isFinite(num) && num >= Number(passMarks || 0);
};
const isPassFromMarks = (row = {}) => {
    const marks = row.marks || {};
    const schema = resultSchemas.find((item) => item.id === row.schemaId) || getSchemaForClass(row.academicYear || currentAcademicYear, row.classLabel || '');
    const subjects = getSchemaSubjectRows(schema || {}, row.examKey || parseExamValue(row.examId || '').examKey);
    const entries = subjects.length
        ? subjects.map((subject) => ({ value: getResultMark(marks, subject), passMarks: subject.passMarks }))
        : Object.values(marks).map((mark) => ({ value: getStoredMarkValue(mark), passMarks: mark?.passMarks ?? 35 }));
    if (!entries.length) return false;
    return entries.every((entry) => isPassingMark(entry.value, entry.passMarks));
};
const buildResultSummary = (marks = {}, subjectRows = []) => {
    let obtained = 0;
    let maximum = 0;
    let hasEntries = false;
    let passStatus = 'PASS';
    const grades = {};
    subjectRows.forEach((subject) => {
        const value = getResultMark(marks, subject);
        if (!value) {
            passStatus = 'FAIL';
            return;
        }
        hasEntries = true;
        maximum += Number(subject.maxMarks || 0);
        const upper = String(value).trim().toUpperCase();
        const num = Number(value);
        if (Number.isFinite(num)) obtained += num;
        if (!isPassingMark(upper, subject.passMarks)) passStatus = 'FAIL';
        grades[subject.id] = isPassingMark(upper, subject.passMarks) ? 'PASS' : 'FAIL';
    });
    return { totals: { obtained, maximum, passStatus: hasEntries ? passStatus : 'FAIL' }, grades };
};

const isAbsentRow = (row = {}) => {
    const marks = Object.values(row.marks || {});
    if (!marks.length) return false;
    return marks.every((m) => {
        const val = getStoredMarkValue(m).toUpperCase();
        return val === 'A' || val === 'AB';
    });
};

const isHighScorerRow = (row = {}) => {
    const max = Number(row.totals?.maximum || 0);
    const obt = Number(row.totals?.obtained || 0);
    return max > 0 && (obt / max) >= 0.8;
};

const computeLiveGradeBadge = (val = '', maxMarks = 100, passMarks = 35) => {
    const raw = String(val ?? '').trim().toUpperCase();
    if (!raw) return { text: '-', badgeClass: 'grade-badge-ab' };
    if (raw === 'P') return { text: 'PASS', badgeClass: 'grade-badge-p' };
    if (raw === 'A' || raw === 'AB') return { text: 'ABSENT', badgeClass: 'grade-badge-ab' };
    const num = Number(raw);
    if (!Number.isFinite(num)) return { text: 'INV', badgeClass: 'grade-badge-f' };
    const max = Number(maxMarks || 100);
    const pass = Number(passMarks || 35);
    if (num > max || num < 0) return { text: 'ERR', badgeClass: 'grade-badge-f' };
    if (num < pass) return { text: 'FAIL', badgeClass: 'grade-badge-f' };
    const pct = (num / max) * 100;
    if (pct >= 90) return { text: 'A+', badgeClass: 'grade-badge-aplus' };
    if (pct >= 80) return { text: 'A', badgeClass: 'grade-badge-a' };
    if (pct >= 60) return { text: 'B', badgeClass: 'grade-badge-b' };
    if (pct >= 35) return { text: 'C', badgeClass: 'grade-badge-c' };
    return { text: 'PASS', badgeClass: 'grade-badge-p' };
};

// --- Authentication & Guard (Username Based) ---
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        try {
            await signInAnonymously(auth);
            return;
        } catch (_err) {
            window.location.replace('index.html');
            return;
        }
    }

    // Get login ID (Username) from current session, exactly like collection-page.js
    const staffAccess = window.AppSession?.getStaffAccess?.() || {};
    currentUserKey = String(staffAccess.loginId || staffAccess.userKey || user.email || '').trim().toLowerCase();
    
    try {
        // 1. Check if user is Master Admin or Admin-privileged staff
        const adminRef = doc(db, `${BASE_PATH}/settings`, ADMIN_AUTH_DOC_ID);
        const adminSnap = await getDoc(adminRef);
        const adminData = adminSnap.exists() ? adminSnap.data() : {};
        const adminEmail = String(adminData.email || '').toLowerCase();
        const adminAccounts = SINGLE_ADMIN_MODE ? [] : (Array.isArray(adminData.admins) ? adminData.admins : []);
        
        isCurrentAdmin = (window.AppSession?.getRole?.() === 'admin')
                         || (staffAccess?.actLikeSuperAdmin === true)
                         || (staffAccess?.canAccessAdmin === true)
                         || (staffAccess?.admin === true)
                         || (user.email && adminEmail === user.email.toLowerCase()) || 
                         (user.email && adminAccounts.some((account) => String(account.email).toLowerCase() === user.email.toLowerCase() && account.isActive !== false));

        // 2. Listen to Staff Collection to check permissions via Username
        onSnapshot(collection(db, `${BASE_PATH}/staff`), async (staffSnap) => {
            allStaff = staffSnap.docs.map(d => ({id: d.id, ...d.data()}));
            const access = await resolveResultAccess({ isAdminUser: isCurrentAdmin, staffDocs: allStaff, user, staffAccess, userKey: currentUserKey });
            if (access.allowed) grantResultAccess(access);
            else denyResultAccess();
        });
        
    } catch (e) {
        console.error("Auth check failed", e);
        denyResultAccess();
    }
});

const grantResultAccess = (accessInfo) => {
    hasResultAccess = true;
    const sessionStaffAccess = window.AppSession?.getStaffAccess?.() || {};
    const isFullAdmin = isCurrentAdmin || accessInfo?.isAdmin || sessionStaffAccess?.actLikeSuperAdmin === true || sessionStaffAccess?.canAccessAdmin === true;
    roleScope = isFullAdmin ? 'admin' : 'staff';
    currentStaffDoc = (accessInfo && typeof accessInfo === 'object') ? accessInfo.staffDoc : null;

    // Extract assigned classes
    if (isFullAdmin) {
        teacherAssignedClasses = [];
    } else {
        teacherAssignedClasses = getStaffAssignedClasses(currentStaffDoc, sessionStaffAccess);
    }

    document.getElementById('access-denied-block').classList.add('hidden');
    document.getElementById('page-content').classList.remove('hidden');

    const displayName = typeof accessInfo === 'string' ? accessInfo : (accessInfo?.label || window.AppSession?.getStaffName?.() || 'RESULT OPERATOR');
    document.getElementById('staff-name-display').textContent = displayName;

    const roleBadge = document.getElementById('staff-role-badge');
    if (roleBadge) {
        roleBadge.textContent = sessionStaffAccess?.actLikeSuperAdmin
            ? 'Super Administrator'
            : (currentStaffDoc?.role || currentStaffDoc?.designation || currentStaffDoc?.type || sessionStaffAccess?.role || (isFullAdmin ? 'Administrator' : 'Class Teacher'));
    }

    // Teacher assigned banner in Overview
    const banner = document.getElementById('teacher-assigned-banner');
    const bannerText = document.getElementById('teacher-assigned-classes-text');
    if (banner && bannerText) {
        if (!isFullAdmin && teacherAssignedClasses.length > 0) {
            bannerText.textContent = teacherAssignedClasses.join(', ');
            banner.classList.remove('hidden');
        } else if (!isFullAdmin) {
            bannerText.textContent = 'All Classes (General Teacher Access)';
            banner.classList.remove('hidden');
        } else {
            banner.classList.add('hidden');
        }
    }

    applyRoleTabVisibility();
    
    if (!window.isResultInitialized) {
        initializeDataListeners();
        window.isResultInitialized = true;
    } else {
        populateDropdowns();
        updateDashboard();
        renderPublishedDraftTables();
    }
};

const denyResultAccess = () => {
    hasResultAccess = false;
    document.getElementById('access-denied-block').classList.remove('hidden');
    document.getElementById('page-content').classList.add('hidden');
};
const applyRoleTabVisibility = () => {
    // Toggle nav items, subpanels, and controls scoped to admin-only
    const adminOnlyNavItems = Array.from(document.querySelectorAll('[data-role-scope="admin-only"]:not(.page-content)'));
    adminOnlyNavItems.forEach((item) => item.classList.toggle('hidden', roleScope !== 'admin'));

    if (roleScope !== 'admin') {
        const adminSections = document.querySelectorAll('.page-content[data-role-scope="admin-only"], .settings-subpanel[data-role-scope="admin-only"]');
        adminSections.forEach((sec) => sec.classList.add('hidden'));

        const activeTab = document.querySelector('.tab-link.active');
        const activeTarget = activeTab?.dataset?.target || '';
        const blockedTargets = new Set(['published-page', 'report-cards-page', 'snapshot-page']);
        if (blockedTargets.has(activeTarget)) {
            const dashboardLink = document.querySelector('.tab-link[data-target="dashboard-page"]');
            dashboardLink?.click();
        }

        // If settings page is active, ensure a teacher-accessible subpanel is visible
        const settingsPage = document.getElementById('settings-page');
        if (settingsPage && !settingsPage.classList.contains('hidden')) {
            const activeSubpanel = document.querySelector('.settings-subpanel:not(.hidden)');
            if (!activeSubpanel || activeSubpanel.id === 'subpanel-publish' || activeSubpanel.id === 'subpanel-promotion') {
                if (typeof activateSettingsSubpanel === 'function') {
                    activateSettingsSubpanel('subpanel-subjects');
                }
            }
        }
    }
};

document.getElementById('logout-btn')?.addEventListener('click', () => {
    signOut(auth).then(async () => {
        await window.AppSession?.clearAll({ purgeClientData: true });
        window.location.replace('index.html'); 
    });
});

// --- Tab Logic ---
const tabs = document.querySelectorAll('.tab-link');
const pages = document.querySelectorAll('.page-content');
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const navMenu = document.querySelector('.nav-menu');

mobileMenuBtn.addEventListener('click', () => {
    navMenu.classList.toggle('active');
    mobileMenuBtn.classList.toggle('active-toggle');
});

const activateResultTab = (tabEl, { updateHash = true } = {}) => {
    if (!tabEl) return;
    tabs.forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-nav-link').forEach((link) => {
        link.classList.remove('active');
        link.style.background = '';
        link.style.color = '';
        link.style.fontWeight = '';
    });
    pages.forEach(p => p.classList.add('hidden'));
    tabEl.classList.add('active');
    const targetPage = document.getElementById(tabEl.dataset.target);
    if(targetPage) targetPage.classList.remove('hidden');

    // Reset viewport scroll to top cleanly and ensure scroll lock is removed
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.body.classList.remove('modal-scroll-lock');

    // Trigger panel refresh when snapshot-page is activated
    if (tabEl.dataset.target === 'snapshot-page') {
        renderSnapshotPanelUI();
    }

    // Toggle full-width layout body class specifically for Marks Entry tab
    if (tabEl.dataset.target === 'marks-page') {
        document.body.classList.add('marks-entry-active');
        updateMarksDownloadAndUploadState();
    } else {
        document.body.classList.remove('marks-entry-active');
    }

    if (updateHash && tabEl.getAttribute('href')?.startsWith('#')) {
        const nextHash = tabEl.getAttribute('href');
        if (window.location.hash !== nextHash) history.pushState({}, '', nextHash);
    }
};
tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
        if(tab.id === 'logout-btn') return;
        if(tab.getAttribute('href') && !tab.getAttribute('href').startsWith('#')) return;

        e.preventDefault();
        activateResultTab(tab);
        
        navMenu.classList.remove('active');
        mobileMenuBtn.classList.remove('active-toggle');
    });
});
window.addEventListener('hashchange', () => {
    const hash = window.location.hash;
    if (hash === '#snapshot' || hash === '#snapshot-export' || hash === '#settings-snapshot') {
        const snapTab = document.querySelector('.tab-link[data-target="snapshot-page"]');
        if (snapTab) {
            activateResultTab(snapTab, { updateHash: false });
            if (hash !== '#snapshot') history.replaceState({}, '', '#snapshot');
            return;
        }
    }
    if (hash === '#settings' || hash === '#settings-page') {
        const settingsPage = document.getElementById('settings-page');
        if (settingsPage) {
            tabs.forEach(t => t.classList.remove('active'));
            pages.forEach(p => p.classList.add('hidden'));
            settingsPage.classList.remove('hidden');
            if (typeof activateSettingsSubpanel === 'function') {
                const defaultSub = (roleScope === 'admin') ? 'subpanel-publish' : 'subpanel-subjects';
                activateSettingsSubpanel(defaultSub);
            }
            return;
        }
    }
    const tab = Array.from(tabs).find((entry) => entry.getAttribute('href') === hash);
    if (tab) {
        activateResultTab(tab, { updateHash: false });
        return;
    }
    const settingsLink = document.querySelector(`.settings-nav-link[href="${hash}"]`);
    if (settingsLink) {
        const settingsPage = document.getElementById('settings-page');
        if (settingsPage) {
            tabs.forEach(t => t.classList.remove('active'));
            pages.forEach(p => p.classList.add('hidden'));
            settingsPage.classList.remove('hidden');
            if (typeof activateSettingsSubpanel === 'function') {
                activateSettingsSubpanel(settingsLink.dataset.subtab);
            }
        }
    }
});

if (window.location.hash) {
    const hash = window.location.hash;
    if (hash === '#snapshot' || hash === '#snapshot-export' || hash === '#settings-snapshot') {
        const snapTab = document.querySelector('.tab-link[data-target="snapshot-page"]');
        if (snapTab) {
            activateResultTab(snapTab, { updateHash: false });
            if (hash !== '#snapshot') history.replaceState({}, '', '#snapshot');
        }
    } else if (hash === '#settings' || hash === '#settings-page') {
        const settingsPage = document.getElementById('settings-page');
        if (settingsPage) {
            tabs.forEach(t => t.classList.remove('active'));
            pages.forEach(p => p.classList.add('hidden'));
            settingsPage.classList.remove('hidden');
            if (typeof activateSettingsSubpanel === 'function') {
                const defaultSub = (roleScope === 'admin') ? 'subpanel-publish' : 'subpanel-subjects';
                activateSettingsSubpanel(defaultSub);
            }
        }
    } else {
        const initialTab = Array.from(tabs).find((entry) => entry.getAttribute('href') === hash);
        if (initialTab) {
            activateResultTab(initialTab, { updateHash: false });
        } else {
            const settingsLink = document.querySelector(`.settings-nav-link[href="${hash}"]`);
            if (settingsLink) {
                const settingsPage = document.getElementById('settings-page');
                if (settingsPage) {
                    tabs.forEach(t => t.classList.remove('active'));
                    pages.forEach(p => p.classList.add('hidden'));
                    settingsPage.classList.remove('hidden');
                    if (typeof activateSettingsSubpanel === 'function') {
                        activateSettingsSubpanel(settingsLink.dataset.subtab);
                    }
                }
            }
        }
    }
}


// --- Data Listeners ---
const initializeDataListeners = () => {
    const scheduleRefresh = debounce(() => {
        try {
            populateDropdowns();
            updateDashboard();
            if (typeof renderSnapshotPanelUI === 'function') {
                renderSnapshotPanelUI();
            }
        } catch (error) {
            reportFatalResultError(error, 'scheduleRefresh');
        }
    }, 150);
    onSnapshot(doc(db, `${BASE_PATH}/settings`, 'academicYears'), (snap) => {
        const payload = snap.exists() ? snap.data() : {};
        currentAcademicYear = payload.currentYear || '';
        const rawYears = Array.isArray(payload.years) ? payload.years.filter(Boolean) : (payload.currentYear ? [payload.currentYear] : []);
        availableAcademicYears = rawYears.filter((y) => {
            if (typeof y === 'object' && y !== null) {
                return String(y.status || '').toLowerCase() !== 'archived';
            }
            return true;
        });
        const badge = document.getElementById('academic-year-badge');
        if (badge) badge.textContent = currentAcademicYear || 'All Years';
        populateReportYears();
        renderSnapshotPanelUI();
        scheduleRefresh();
    });
    onSnapshot(doc(db, `${BASE_PATH}/settings`, 'config'), (snap) => {
        const conf = snap.exists() ? (snap.data() || {}) : {};
        institutionConfig = conf;
        applyInstitutionBranding(conf, {
            defaultAppName: 'Result Management',
            logoIds: ['header-logo', 'splash-logo-img'],
            updateDocumentTitle: true,
            documentTitleSuffix: 'Result Management'
        });
    });

    onSnapshot(collection(db, `${BASE_PATH}/students`), (snap) => {
        students = snap.docs.map(d => ({id: d.id, ...d.data()}));
        classes = [...new Set(students.map(s => s.class).filter(Boolean))]
            .filter((c) => String(c).trim().toLowerCase() !== 'alumni')
            .sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
        scheduleRefresh();
    });

    onSnapshot(collection(db, `${BASE_PATH}/resultSchemas`), (snap) => {
        resultSchemas = snap.docs.map((d) => normalizeResultSchema({ id: d.id, ...d.data() }));
        renderExamSetup();
        scheduleRefresh();
    });

    onSnapshot(collection(db, `${BASE_PATH}/examResults`), (snap) => {
        examResultsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        scheduleRefresh();
    });

    onSnapshot(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), (snap) => {
        if(snap.exists()) {
            resultCenterSettings = snap.data();
        }
        scheduleRefresh();
        
        const pubInput = document.getElementById('publish-title');
        if(pubInput && resultCenterSettings.examLabel) pubInput.value = resultCenterSettings.examLabel;
        const publishAtInput = document.getElementById('publish-at-input');
        if (publishAtInput) publishAtInput.value = resultCenterSettings.publishAt || '';
        const publishYearSelect = document.getElementById('publish-academic-year');
        if (publishYearSelect && resultCenterSettings.publishAcademicYear) publishYearSelect.value = resultCenterSettings.publishAcademicYear;
        const publishExamSelect = document.getElementById('publish-exam-select');
        if (publishExamSelect && resultCenterSettings.publishExamKey) publishExamSelect.value = resultCenterSettings.publishExamKey;
        updatePublishLiveStatus();
        renderGradeRules();
        renderBlockedClasses();
        renderPublishedHistoryTable();
        renderPromotionMappingUI();
        renderResultVisibilitySettings();
    });
};

const DEFAULT_GRADE_SCALES = {
    100: [
        { grade: 'A+', min: 90, max: 100 },
        { grade: 'A', min: 80, max: 89.99 },
        { grade: 'B', min: 60, max: 79.99 },
        { grade: 'C', min: 35, max: 59.99 },
        { grade: 'F', min: 0, max: 34.99 }
    ],
    50: [
        { grade: 'A+', min: 45, max: 50 },
        { grade: 'A', min: 40, max: 44.99 },
        { grade: 'B', min: 30, max: 39.99 },
        { grade: 'C', min: 18, max: 29.99 },
        { grade: 'F', min: 0, max: 17.99 }
    ]
};

const getEffectiveGradeScales = () => {
    const customScales = resultCenterSettings.gradeScales || {};
    const scales = {
        100: JSON.parse(JSON.stringify(DEFAULT_GRADE_SCALES[100])),
        50: JSON.parse(JSON.stringify(DEFAULT_GRADE_SCALES[50]))
    };
    Object.keys(customScales).forEach((key) => {
        if (Array.isArray(customScales[key]) && customScales[key].length) {
            scales[Number(key)] = customScales[key];
        }
    });
    if (resultCenterSettings.gradeRules && Array.isArray(resultCenterSettings.gradeRules) && resultCenterSettings.gradeRules.length) {
        const legacyScale = Number(resultCenterSettings.gradeScaleTotal || 100);
        if (!customScales[legacyScale]) {
            scales[legacyScale] = resultCenterSettings.gradeRules;
        }
    }
    return scales;
};

const renderGradeRules = (selectedTotal) => {
    const totalInput = document.getElementById('grade-scale-total-input');
    const total = selectedTotal !== undefined 
        ? Number(selectedTotal) 
        : (totalInput ? Number(totalInput.value) || 100 : 100);
    if (totalInput) totalInput.value = total;

    const scales = getEffectiveGradeScales();
    let currentRules = scales[total];
    if (!currentRules || !currentRules.length) {
        // Generate sensible proportional scale from 100 scale
        const base100 = scales[100] || DEFAULT_GRADE_SCALES[100];
        currentRules = base100.map((r) => ({
            grade: r.grade,
            min: Math.round((Number(r.min || 0) / 100) * total * 10) / 10,
            max: Math.round((Number(r.max || 0) / 100) * total * 10) / 10
        }));
    }

    const container = document.getElementById('grade-rules-rows');
    if (container) {
        container.innerHTML = currentRules.map((rule, index) => `
            <div class="grid grid-cols-12 gap-2 items-center grade-rule-row">
                <div class="col-span-4 sm:col-span-3">
                    <input type="text" class="grade-grade w-full p-2 border rounded-lg text-sm font-bold bg-white text-slate-800" data-index="${index}" value="${escapeHtml(rule.grade || '')}" placeholder="e.g. A+">
                </div>
                <div class="col-span-3 sm:col-span-4">
                    <input type="number" step="0.01" class="grade-min w-full p-2 border rounded-lg text-sm bg-white text-slate-800" data-index="${index}" value="${rule.min ?? 0}" placeholder="Min Mark">
                </div>
                <div class="col-span-3 sm:col-span-4">
                    <input type="number" step="0.01" class="grade-max w-full p-2 border rounded-lg text-sm bg-white text-slate-800" data-index="${index}" value="${rule.max ?? 0}" placeholder="Max Mark">
                </div>
                <div class="col-span-2 sm:col-span-1 text-center">
                    <button type="button" class="remove-grade-rule-row text-red-500 hover:text-red-700 p-1.5 rounded transition" title="Delete rule row">
                        <i class="fas fa-trash-alt text-xs"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }

    renderSavedGradeScales();
};

const renderSavedGradeScales = () => {
    const container = document.getElementById('saved-grade-scales-container');
    if (!container) return;
    const scales = getEffectiveGradeScales();
    const sortedKeys = Object.keys(scales).map(Number).sort((a, b) => b - a);

    container.innerHTML = sortedKeys.map((key) => {
        const rules = scales[key] || [];
        const isDefault = key === 100 || key === 50;
        const badgesHtml = rules.map((r) => `
            <span class="inline-flex items-center gap-1 bg-slate-50 border border-slate-200 text-slate-700 px-2.5 py-1 rounded-md text-xs font-medium">
                <strong class="font-extrabold text-indigo-700">${escapeHtml(r.grade)}</strong>: ${r.min} - ${r.max}
            </span>
        `).join('');

        return `
        <div class="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:border-indigo-300 transition flex flex-col justify-between">
            <div>
                <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2">
                        <span class="text-base font-extrabold text-slate-800">${key} Total Marks</span>
                        ${isDefault ? '<span class="text-[10px] bg-indigo-50 text-indigo-700 border border-indigo-200 font-bold px-2 py-0.5 rounded-full">System Default</span>' : '<span class="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold px-2 py-0.5 rounded-full">Custom Scale</span>'}
                    </div>
                </div>
                <div class="flex flex-wrap gap-1.5 my-3">
                    ${badgesHtml || '<span class="text-xs text-slate-400 italic">No grade rules configured</span>'}
                </div>
            </div>
            <div class="pt-3 border-t flex justify-end items-center">
                <button type="button" class="edit-saved-scale-btn bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-bold py-1.5 px-3 rounded-lg transition flex items-center gap-1.5" data-total="${key}">
                    <i class="fas fa-edit"></i> Edit Scale
                </button>
            </div>
        </div>
        `;
    }).join('');
};
const renderBlockedClasses = () => {
    const container = document.getElementById('blocked-classes-list');
    if (!container) return;
    container.innerHTML = classes.map((cls) => `<label class="text-sm font-medium flex items-center gap-2"><input type="checkbox" class="blocked-class-checkbox" value="${cls}" ${resultCenterSettings.blockedClasses?.includes(cls) ? 'checked' : ''}>${cls}</label>`).join('');
};
const renderPromotionCandidatesUI = () => {
    const currentYearBadge = document.getElementById('promotion-current-year-badge');
    if (currentYearBadge) currentYearBadge.textContent = currentAcademicYear || 'N/A';

    const yearSelect = document.getElementById('promotion-target-year');
    if (yearSelect) {
        const normalizeYear = (entry) => {
            if (!entry) return '';
            if (typeof entry === 'string') return entry;
            if (typeof entry === 'object') return String(entry.value || entry.year || entry.label || '').trim();
            return String(entry).trim();
        };
        const options = availableAcademicYears
            .map((year) => normalizeYear(year))
            .filter((year) => year && year !== currentAcademicYear);

        if (!options.length && currentAcademicYear) {
            const startYear = parseInt(String(currentAcademicYear).split('-')[0], 10);
            if (!isNaN(startYear)) {
                options.push(`${startYear + 1}-${startYear + 2}`);
            }
        }

        const currentTargetVal = yearSelect.value;
        const previousOptionsHtml = yearSelect.innerHTML;
        if (!previousOptionsHtml || yearSelect.options.length <= 1) {
            yearSelect.innerHTML = `<option value="">Select Next Year</option>${options.map((year, idx) => `<option value="${escapeHtml(year)}" ${currentTargetVal === year || (!currentTargetVal && idx === 0) ? 'selected' : ''}>${escapeHtml(year)}</option>`).join('')}`;
        }
    }

    const container = document.getElementById('promotion-preview-list');
    if (!container) return;

    const annualRows = examResultsCache.filter((row) => row.published === true && detectAnnualResultRow(row));
    const promotableClasses = classes.filter((cls) => String(cls).trim().toLowerCase() !== 'alumni');
    const progressionMap = resultCenterSettings.classProgressionMap || {};

    const targetChoices = [...classes.filter((c) => String(c).trim().toLowerCase() !== 'alumni')];
    if (!targetChoices.includes('Alumni')) targetChoices.push('Alumni');

    const summaryMap = new Map(promotableClasses.map((cls, idx) => {
        const defaultNext = progressionMap[cls] !== undefined ? progressionMap[cls] : (promotableClasses[idx + 1] || 'Alumni');
        return [cls, { pass: 0, fail: 0, total: 0, boys: 0, girls: 0, nextClass: defaultNext }];
    }));

    annualRows.forEach((row) => {
        const student = students.find((entry) => entry.id === row.studentId);
        const fromClass = student?.class || row.classLabel || '';
        if (!fromClass || !summaryMap.has(fromClass)) return;
        const passed = isPassFromMarks(row);
        const gender = String(student?.gender || '').toLowerCase();
        const item = summaryMap.get(fromClass);
        item.total += 1;
        if (gender.startsWith('m') || gender.includes('boy')) item.boys += 1;
        if (gender.startsWith('f') || gender.includes('girl')) item.girls += 1;
        if (passed) item.pass += 1;
        else item.fail += 1;
    });

    if (summaryMap.size === 0) {
        container.innerHTML = `<div class="p-6 text-center text-xs text-slate-400 italic bg-slate-50 rounded-xl border border-dashed border-slate-200">No classes found in the system for promotion review.</div>`;
        return;
    }

    container.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            ${Array.from(summaryMap.entries()).map(([cls, stat]) => {
                const selectedTarget = stat.nextClass;
                const options = [
                    `<option value="Alumni" ${selectedTarget === 'Alumni' ? 'selected' : ''}>🎓 Alumni (Pass Out)</option>`,
                    ...targetChoices.filter((opt) => opt !== 'Alumni').map((opt) => `<option value="${escapeHtml(opt)}" ${selectedTarget === opt ? 'selected' : ''}>Class ${escapeHtml(opt)}</option>`),
                    `<option value="" ${selectedTarget === '' ? 'selected' : ''}>-- No Promotion (Remain / Discontinue) --</option>`
                ].join('');

                const isAlumni = String(selectedTarget).trim().toLowerCase() === 'alumni';

                return `
                <div class="border border-slate-200 rounded-2xl p-4 bg-white shadow-xs hover:border-indigo-300 transition flex flex-col justify-between" data-class="${escapeHtml(cls)}">
                    <div>
                        <div class="flex items-center justify-between border-b border-slate-100 pb-2.5 mb-3">
                            <span class="font-bold text-slate-800 text-sm flex items-center gap-2">
                                <span class="w-6 h-6 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center text-xs font-extrabold">
                                    <i class="fas fa-layer-group"></i>
                                </span>
                                Class ${escapeHtml(cls)}
                            </span>
                            <span id="badge-target-${escapeHtml(cls)}" class="text-[10px] font-bold ${isAlumni ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-indigo-50 text-indigo-700 border border-indigo-200'} px-2 py-0.5 rounded-full">
                                ${isAlumni ? '🎓 To Alumni' : `To ${escapeHtml(selectedTarget || 'None')}`}
                            </span>
                        </div>

                        <div class="grid grid-cols-3 gap-2 text-center text-xs mb-3">
                            <div class="bg-slate-50 p-2 rounded-xl border border-slate-100">
                                <span class="text-[10px] text-slate-400 block font-semibold uppercase">Total</span>
                                <strong class="text-slate-800 font-extrabold text-sm">${stat.total}</strong>
                            </div>
                            <div class="bg-emerald-50 p-2 rounded-xl border border-emerald-100">
                                <span class="text-[10px] text-emerald-600 block font-semibold uppercase">Pass</span>
                                <strong class="text-emerald-700 font-extrabold text-sm">${stat.pass}</strong>
                            </div>
                            <div class="bg-red-50 p-2 rounded-xl border border-red-100">
                                <span class="text-[10px] text-red-500 block font-semibold uppercase">Fail</span>
                                <strong class="text-red-700 font-extrabold text-sm">${stat.fail}</strong>
                            </div>
                        </div>

                        <div class="flex justify-between items-center text-[11px] text-slate-500 mb-3 px-1">
                            <span>Boys: <strong class="text-slate-700">${stat.boys}</strong> • Girls: <strong class="text-slate-700">${stat.girls}</strong></span>
                            <span class="font-bold text-indigo-600">${stat.total ? Math.round((stat.pass / stat.total) * 100) : 0}% Pass Rate</span>
                        </div>
                    </div>

                    <div class="pt-3 border-t border-slate-100 bg-slate-50/70 -mx-4 -mb-4 p-3 rounded-b-2xl">
                        <label class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                            <i class="fas fa-sign-in-alt text-indigo-500 mr-1"></i> Promote Eligible Students To:
                        </label>
                        <select class="promotion-target-class-select w-full p-2 border border-slate-200 rounded-xl text-xs font-bold text-slate-800 bg-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition" data-class="${escapeHtml(cls)}">
                            ${options}
                        </select>
                    </div>
                </div>
                `;
            }).join('')}
        </div>
    `;

    // Listen to changes on promotion target class selects
    container.querySelectorAll('.promotion-target-class-select').forEach((sel) => {
        sel.addEventListener('change', () => {
            const cls = sel.dataset.class;
            const targetVal = sel.value;
            const badge = document.getElementById(`badge-target-${cls}`);
            if (badge) {
                const isTargetAlumni = String(targetVal).trim().toLowerCase() === 'alumni';
                badge.className = `text-[10px] font-bold ${isTargetAlumni ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-indigo-50 text-indigo-700 border border-indigo-200'} px-2 py-0.5 rounded-full`;
                badge.textContent = isTargetAlumni ? '🎓 To Alumni' : (targetVal ? `To ${targetVal}` : 'No Promotion');
            }
        });
    });
};
const renderPromotionMappingUI = renderPromotionCandidatesUI;
const buildVisibilityKey = (classLabel = '', examKey = '') => `${classLabel}__${examKey}`;
const renderResultVisibilitySettings = () => {
    const container = document.getElementById('result-visibility-grid');
    if (!container) return;
    const map = resultCenterSettings.resultVisibilityMap || {};
    const rows = [];
    const classList = [...new Set(resultSchemas.filter((schema) => schema.academicYear === currentAcademicYear || !schema.academicYear).map((schema) => schema.classLabel).filter(Boolean))];
    classList.forEach((cls) => rows.push(`<button class="visibility-class-card border rounded-lg p-3 bg-white text-left hover:border-indigo-400" data-class="${escapeHtml(cls)}"><div class="font-bold">${escapeHtml(cls)}</div><div class="text-xs text-gray-500">Click to manage exam visibility</div></button>`));
    container.innerHTML = rows.length ? rows.join('') : '<div class="text-sm text-gray-500">No class/exam entries found.</div>';
};
const formatDateTimeLabel = (value = '') => {
    if (!value) return 'Not scheduled';
    const ts = new Date(value);
    if (Number.isNaN(ts.getTime())) return 'Invalid date/time';
    return ts.toLocaleString();
};
let editingPublishRecordId = null;

const setPublishModeVisual = (mode = 'publish_now') => {
    const cardNow = document.getElementById('mode-card-now');
    const cardSchedule = document.getElementById('mode-card-schedule');
    const scheduleContainer = document.getElementById('publish-schedule-datetime-container');
    const labelSpan = document.getElementById('run-publish-btn-label');

    if (mode === 'publish_now') {
        if (cardNow) {
            cardNow.className = 'cursor-pointer border-2 border-indigo-600 bg-white rounded-xl p-3.5 flex items-start gap-3 transition shadow-xs';
        }
        if (cardSchedule) {
            cardSchedule.className = 'cursor-pointer border-2 border-slate-200 bg-white rounded-xl p-3.5 flex items-start gap-3 transition shadow-xs hover:border-indigo-400';
        }
        scheduleContainer?.classList.add('hidden');
        if (labelSpan && !editingPublishRecordId) labelSpan.textContent = 'Publish Now';
    } else {
        if (cardSchedule) {
            cardSchedule.className = 'cursor-pointer border-2 border-indigo-600 bg-white rounded-xl p-3.5 flex items-start gap-3 transition shadow-xs';
        }
        if (cardNow) {
            cardNow.className = 'cursor-pointer border-2 border-slate-200 bg-white rounded-xl p-3.5 flex items-start gap-3 transition shadow-xs hover:border-indigo-400';
        }
        scheduleContainer?.classList.remove('hidden');
        if (labelSpan && !editingPublishRecordId) labelSpan.textContent = 'Save Schedule';
    }
    updatePublishLiveStatus();
};

const updatePublishLiveStatus = () => {
    const el = document.getElementById('publish-live-status');
    const badgeEl = document.getElementById('publish-live-status-badge');
    if (!el && !badgeEl) return;
    const nowTs = Date.now();
    const scheduleValue = document.getElementById('publish-at-input')?.value || resultCenterSettings.publishAt || '';
    const scheduleTs = scheduleValue ? new Date(scheduleValue).getTime() : 0;
    const title = document.getElementById('publish-title')?.value?.trim() || resultCenterSettings.examLabel || 'Upcoming Exam';
    const isNowMode = document.querySelector('input[name="publish-action"]:checked')?.value === 'publish_now';
    
    let line = `Exam: ${title} | Target Year: ${document.getElementById('publish-academic-year')?.value || currentAcademicYear || '-'}`;
    if (isNowMode) {
        line += ` | Mode: Publish Immediately`;
        if (badgeEl) {
            badgeEl.className = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 self-start sm:self-auto';
            badgeEl.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span>Status: Ready to Publish Live</span>';
        }
    } else if (scheduleTs && scheduleTs > nowTs) {
        line += ` | Scheduled: ${formatDateTimeLabel(scheduleValue)}`;
        if (badgeEl) {
            badgeEl.className = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200 self-start sm:self-auto';
            badgeEl.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span><span>Status: Countdown Scheduled</span>';
        }
    } else if (scheduleTs && scheduleTs <= nowTs) {
        line += ` | Live Window Reached (${formatDateTimeLabel(scheduleValue)})`;
        if (badgeEl) {
            badgeEl.className = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 self-start sm:self-auto';
            badgeEl.innerHTML = '<span class="w-2 h-2 rounded-full bg-indigo-500"></span><span>Status: Live Published</span>';
        }
    } else {
        line += ` | Mode: Scheduled (Select date & time)`;
        if (badgeEl) {
            badgeEl.className = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-slate-100 text-slate-600 border border-slate-200 self-start sm:self-auto';
            badgeEl.innerHTML = '<span class="w-2 h-2 rounded-full bg-slate-400"></span><span>Status: No schedule set</span>';
        }
    }
    if (el) el.textContent = line;
};

const getPublishHistoryRecords = () => {
    let history = Array.isArray(resultCenterSettings.publishHistory) ? [...resultCenterSettings.publishHistory] : [];
    if (!history.length && resultCenterSettings.publishAt && (resultCenterSettings.publishAcademicYear || resultCenterSettings.examLabel)) {
        history.push({
            id: 'legacy_active',
            academicYear: resultCenterSettings.publishAcademicYear || currentAcademicYear || 'Current Year',
            examKey: resultCenterSettings.publishExamKey || 'general',
            examLabel: resultCenterSettings.examLabel || 'Active Exam Results',
            publishType: (resultCenterSettings.publishAt && new Date(resultCenterSettings.publishAt).getTime() > Date.now()) ? 'scheduled' : 'now',
            publishAt: resultCenterSettings.publishAt,
            blockedClasses: Array.isArray(resultCenterSettings.blockedClasses) ? resultCenterSettings.blockedClasses : [],
            createdAt: resultCenterSettings.updatedAt || Date.now()
        });
    }
    // Reverse chronological order: newest created/published at top
    history.sort((a, b) => {
        const timeA = new Date(a.createdAt || a.publishAt || 0).getTime();
        const timeB = new Date(b.createdAt || b.publishAt || 0).getTime();
        return timeB - timeA;
    });
    return history;
};

const renderPublishedHistoryTable = () => {
    const tbody = document.getElementById('published-history-table-body');
    if (!tbody) return;
    const yearFilter = document.getElementById('publish-history-year-filter')?.value || '';
    let records = getPublishHistoryRecords();
    if (yearFilter) {
        records = records.filter((r) => (r.academicYear || '') === yearFilter);
    }
    if (!records.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="p-8 text-center text-slate-400">
                    <div class="flex flex-col items-center justify-center gap-1.5">
                        <i class="fas fa-inbox text-2xl text-slate-300"></i>
                        <span class="text-xs font-semibold">No published exam records found.</span>
                        <span class="text-[11px] text-slate-400">Use the form above to publish or schedule results.</span>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    const now = Date.now();
    tbody.innerHTML = records.map((record) => {
        const isScheduled = record.publishType === 'scheduled';
        const targetTs = record.publishAt ? new Date(record.publishAt).getTime() : 0;
        const isLive = !isScheduled || (targetTs && targetTs <= now);
        const blockedList = Array.isArray(record.blockedClasses) ? record.blockedClasses : [];
        const isUnpublished = record.publishType === 'unpublished' || record.status === 'Unpublished';

        // Match all student results for this exam in this academic year
        const recYear = record.academicYear;
        const recExamKey = record.examKey;
        const matchingResults = examResultsCache.filter((row) => {
            const matchesYear = !row.academicYear || row.academicYear === recYear;
            const matchesExam = resultMatchesExam(row, recExamKey);
            return matchesYear && matchesExam;
        });

        const livePublishedRows = matchingResults.filter((r) => r.published === true);
        const draftRows = matchingResults.filter((r) => r.published !== true);
        const draftsInOpenClasses = draftRows.filter((r) => !blockedList.includes(r.classLabel));
        const draftsInBlockedClasses = draftRows.filter((r) => blockedList.includes(r.classLabel));

        // Group by class to identify status for each class
        const classStatsMap = {};
        matchingResults.forEach((row) => {
            const cls = row.classLabel || 'Unknown';
            if (!classStatsMap[cls]) classStatsMap[cls] = { total: 0, published: 0, draft: 0 };
            classStatsMap[cls].total++;
            if (row.published === true) classStatsMap[cls].published++;
            else classStatsMap[cls].draft++;
        });

        // Classes breakdown badges
        const classBadges = [];
        Object.entries(classStatsMap).forEach(([cls, stats]) => {
            const isBlocked = blockedList.includes(cls);
            if (isBlocked) {
                classBadges.push(`<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-50 text-red-700 border border-red-200" title="Class is blocked from publishing"><i class="fas fa-ban text-[9px]"></i> ${escapeHtml(cls)} (Blocked: ${stats.draft} draft)</span>`);
            } else if (stats.draft > 0) {
                classBadges.push(`<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-300" title="Class has un-published drafts"><i class="fas fa-clock text-[9px]"></i> ${escapeHtml(cls)} (${stats.draft} draft pending)</span>`);
            } else {
                classBadges.push(`<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200" title="All results published"><i class="fas fa-check text-[9px]"></i> ${escapeHtml(cls)} (${stats.published} live)</span>`);
            }
        });

        // Add any configured blocked classes that do not have student marks yet
        blockedList.forEach((cls) => {
            if (!classStatsMap[cls]) {
                classBadges.push(`<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-50 text-red-700 border border-red-200"><i class="fas fa-ban text-[9px]"></i> ${escapeHtml(cls)} (Blocked)</span>`);
            }
        });

        const classScopeHtml = classBadges.length
            ? `<div class="flex flex-wrap gap-1 max-w-xs">${classBadges.join('')}</div>`
            : `<span class="text-[11px] text-slate-400 italic">No class results entered</span>`;

        // Live Students & Sync Status UI
        const syncStatusHtml = `
            <div class="space-y-1">
                <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-extrabold bg-emerald-50 text-emerald-700 border border-emerald-200">
                        <i class="fas fa-check-circle text-[10px]"></i> ${livePublishedRows.length} Live
                    </span>
                    ${draftsInOpenClasses.length > 0 ? `
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-extrabold bg-amber-50 text-amber-800 border border-amber-300 animate-pulse" title="${draftsInOpenClasses.length} new draft results in open classes need publishing">
                            <i class="fas fa-exclamation-triangle text-[10px]"></i> ${draftsInOpenClasses.length} Pending Drafts
                        </span>
                    ` : ''}
                    ${draftsInBlockedClasses.length > 0 ? `
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200" title="${draftsInBlockedClasses.length} drafts in blocked classes">
                            ${draftsInBlockedClasses.length} in Blocked
                        </span>
                    ` : ''}
                </div>
                ${draftsInOpenClasses.length > 0 && !isUnpublished ? `
                    <div class="text-[10px] text-amber-700 font-semibold flex items-center gap-1">
                        <i class="fas fa-info-circle"></i> New marks entered; click 'Publish Pending' to sync
                    </div>
                ` : (draftsInOpenClasses.length === 0 && livePublishedRows.length > 0) ? `
                    <div class="text-[10px] text-emerald-600 font-semibold flex items-center gap-1">
                        <i class="fas fa-circle-check text-[9px]"></i> All open results synced & live
                    </div>
                ` : ''}
            </div>
        `;

        const modeBadge = isUnpublished
            ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold bg-slate-100 text-slate-600 border border-slate-200"><i class="fas fa-undo text-[10px]"></i> Reverted to Draft</span>`
            : isScheduled
            ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200"><i class="fas fa-clock text-[10px]"></i> Auto Publish (${formatDateTimeLabel(record.publishAt)})</span>`
            : `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-200"><i class="fas fa-bolt text-[10px]"></i> Publish Now</span>`;

        const statusBadge = isUnpublished
            ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600 border border-slate-200"><span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span> Draft</span>`
            : isLive
            ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Live</span>`
            : `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-200"><span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span> Countdown</span>`;

        const unpublishBtnHtml = !isUnpublished
            ? `<button type="button" class="unpublish-record-btn px-2.5 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 font-bold text-xs transition flex items-center gap-1" data-id="${escapeHtml(record.id)}" title="Unpublish results back to draft">
                    <i class="fas fa-undo"></i> Unpublish
               </button>`
            : '';

        const publishPendingBtnHtml = (draftsInOpenClasses.length > 0 && !isUnpublished)
            ? `<button type="button" class="publish-pending-record-btn px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition flex items-center gap-1 shadow-sm" data-id="${escapeHtml(record.id)}" title="Publish all ${draftsInOpenClasses.length} new draft results in open classes">
                    <i class="fas fa-bolt"></i> Publish ${draftsInOpenClasses.length} Pending
               </button>`
            : '';

        return `
            <tr class="hover:bg-slate-50/80 transition" data-id="${escapeHtml(record.id)}">
                <td class="py-3 px-4 whitespace-nowrap">
                    <span class="inline-block px-2.5 py-1 rounded-md text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                        ${escapeHtml(record.academicYear || currentAcademicYear || 'N/A')}
                    </span>
                </td>
                <td class="py-3 px-4">
                    <div class="font-bold text-slate-800 text-xs">${escapeHtml(record.examLabel || record.examKey || 'Exam')}</div>
                    <div class="text-[10px] text-slate-500 font-medium">${escapeHtml(record.examKey || '')}</div>
                </td>
                <td class="py-3 px-4 whitespace-nowrap">
                    <div class="flex flex-col gap-1 items-start">
                        ${statusBadge}
                        ${modeBadge}
                    </div>
                </td>
                <td class="py-3 px-4 whitespace-nowrap">
                    ${syncStatusHtml}
                </td>
                <td class="py-3 px-4">
                    ${classScopeHtml}
                </td>
                <td class="py-3 px-4 text-center whitespace-nowrap">
                    <div class="inline-flex items-center gap-1">
                        ${publishPendingBtnHtml}
                        ${unpublishBtnHtml}
                        <button type="button" class="edit-publish-record-btn px-2.5 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold text-xs transition flex items-center gap-1" data-id="${escapeHtml(record.id)}">
                            <i class="fas fa-edit"></i> Edit
                        </button>
                        <button type="button" class="delete-publish-record-btn px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 font-bold text-xs transition flex items-center gap-1" data-id="${escapeHtml(record.id)}" title="Delete record and revert results to draft">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
};

const renderPublishControls = () => {
    const yearSelect = document.getElementById('publish-academic-year');
    const examSelect = document.getElementById('publish-exam-select');
    if (!yearSelect || !examSelect) return;
    const years = [...new Set([currentAcademicYear, ...resultSchemas.map((s) => s.academicYear).filter(Boolean)])].filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)));
    const prevYear = yearSelect.value || resultCenterSettings.publishAcademicYear || currentAcademicYear;
    yearSelect.innerHTML = years.map((year) => `<option value="${year}">${year}</option>`).join('');
    yearSelect.value = years.includes(prevYear) ? prevYear : (years[0] || currentAcademicYear);
    const selectedYear = yearSelect.value;
    const examsMap = new Map();
    resultSchemas
        .filter((schema) => (schema.academicYear || currentAcademicYear) === selectedYear)
        .forEach((schema) => {
            getExamOptionsForClass(schema.classLabel, selectedYear).forEach((exam) => {
                const key = exam.key || parseExamValue(exam.value).examKey || exam.value;
                if (!key || examsMap.has(key)) return;
                examsMap.set(key, { value: key, label: exam.label || key });
            });
        });
    const exams = Array.from(examsMap.values());
    const prevExam = examSelect.value || resultCenterSettings.publishExamKey || '';
    examSelect.innerHTML = `<option value="">-- Choose Academic Exam --</option>${exams.map((exam) => `<option value="${exam.value}">${escapeHtml(exam.label)}</option>`).join('')}`;
    if (prevExam) examSelect.value = prevExam;

    const historyYearSelect = document.getElementById('publish-history-year-filter');
    if (historyYearSelect) {
        const prevFilter = historyYearSelect.value;
        historyYearSelect.innerHTML = '<option value="">All Academic Years</option>' + years.map((y) => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join('');
        if (prevFilter) historyYearSelect.value = prevFilter;
    }

    renderPublishedHistoryTable();
};
const updateReportPreview = () => {
    const preview = document.getElementById('report-preview-summary');
    if (!preview) return;
    const targetYear = document.getElementById('report-academic-year')?.value?.trim() || currentAcademicYear || '';
    const className = document.getElementById('report-class-select')?.value || '';
    const examId = document.getElementById('report-exam-select')?.value || '';
    if (!className || !examId) {
        preview.textContent = 'Select year, class and exam to preview result availability.';
        return;
    }
    const rows = examResultsCache.filter((row) => resultMatchesExam(row, examId) && row.classLabel === className && (!targetYear || row.academicYear === targetYear || !row.academicYear));
    const publishedCount = rows.filter((row) => row.published === true).length;
    preview.textContent = `Academic Year: ${targetYear || 'All'} | Records: ${rows.length} | Published: ${publishedCount} | Draft: ${Math.max(rows.length - publishedCount, 0)}`;
};

const renderExamSelectOptions = (selectEl, classLabel = '', year = currentAcademicYear, placeholder = '-- Choose Exam --', onlyPublished = false) => {
    if (!selectEl) return;
    const previous = selectEl.value;
    const baseOptions = classLabel
        ? getExamOptionsForClass(classLabel, year)
        : DEFAULT_EXAM_DEFS.map((exam) => ({ value: makeExamValue('__all', exam.key), key: exam.key, label: exam.label }));
    const options = baseOptions.filter((option) => !onlyPublished || examResultsCache.some((row) => row.published === true && (!classLabel || row.classLabel === classLabel) && row.academicYear === year && resultMatchesExam(row, option.value)));
    selectEl.innerHTML = `<option value="">${placeholder}</option>` + options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
    if (previous && Array.from(selectEl.options).some((option) => option.value === previous)) selectEl.value = previous;
};
const populateReportYears = () => {
    const el = document.getElementById('report-academic-year');
    if (!el) return;
    const previous = el.value;
    const years = [...new Set(examResultsCache.filter((row) => row.published === true && row.academicYear).map((row) => row.academicYear))].sort((a,b) => String(b).localeCompare(String(a), undefined, { numeric: true }));
    const fallback = currentAcademicYear ? [currentAcademicYear] : [];
    const source = years.length ? years : fallback;
    el.innerHTML = `<option value="">-- Select Academic Year --</option>` + source.map((year) => `<option value="${escapeHtml(year)}">${escapeHtml(year)}</option>`).join('');
    el.value = previous && source.includes(previous) ? previous : (source[0] || '');
};
const populateDropdowns = () => {
    const isTeacherScope = (roleScope === 'staff' && teacherAssignedClasses.length > 0);
    const teacherAllowedClasses = isTeacherScope ? classes.filter((c) => teacherAssignedClasses.includes(c)) : classes;
    const entryClassOpts = `<option value="">-- Choose Class --</option>` + teacherAllowedClasses.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    const allClassOpts = `<option value="">-- Choose Class --</option>` + classes.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

    const entryClassSelect = document.getElementById('entry-class-select');
    const reportClassSelect = document.getElementById('report-class-select');
    const subjectClassSelect = document.getElementById('subject-class-select');
    const examConfigClassSelect = document.getElementById('exam-config-class-select');

    if (entryClassSelect) {
        const current = entryClassSelect.value;
        entryClassSelect.innerHTML = entryClassOpts;
        if (teacherAllowedClasses.length === 1) {
            entryClassSelect.value = teacherAllowedClasses[0];
        } else if (current && teacherAllowedClasses.includes(current)) {
            entryClassSelect.value = current;
        }
        updateMarksDownloadAndUploadState();
    }

    if (reportClassSelect) {
        const current = reportClassSelect.value;
        reportClassSelect.innerHTML = allClassOpts;
        if (current && classes.includes(current)) reportClassSelect.value = current;
    }

    const subjectClassOpts = `<option value="">-- Choose Class --</option>` + teacherAllowedClasses.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

    [subjectClassSelect, examConfigClassSelect].forEach((select) => {
        if (!select) return;
        const current = select.value;
        select.innerHTML = subjectClassOpts;
        if (teacherAllowedClasses.length === 1) {
            select.value = teacherAllowedClasses[0];
        } else if (current && teacherAllowedClasses.includes(current)) {
            select.value = current;
        }
    });

    const schemaListClassFilter = document.getElementById('schema-list-class-filter');
    if (schemaListClassFilter) {
        const currentFilter = schemaListClassFilter.value;
        const filterOpts = isTeacherScope
            ? (teacherAllowedClasses.length === 1
                ? teacherAllowedClasses.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')
                : `<option value="">All My Classes</option>` + teacherAllowedClasses.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join(''))
            : `<option value="">All Classes</option>` + classes.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
        schemaListClassFilter.innerHTML = filterOpts;
        if (teacherAllowedClasses.length === 1 && isTeacherScope) {
            schemaListClassFilter.value = teacherAllowedClasses[0];
        } else if (currentFilter && teacherAllowedClasses.includes(currentFilter)) {
            schemaListClassFilter.value = currentFilter;
        }
    }
    renderExamConfigRowsForSelectedClass();
    renderExamSetup();
    populateReportYears();
    renderExamSelectOptions(document.getElementById('entry-exam-select'), entryClassSelect?.value || '', currentAcademicYear);
    renderExamSelectOptions(document.getElementById('report-exam-select'), reportClassSelect?.value || '', document.getElementById('report-academic-year')?.value || currentAcademicYear, '-- Choose Exam --', true);
};

// --- Dashboard ---
const updateDashboard = () => {
    const isTeacherScope = (roleScope === 'staff' && teacherAssignedClasses.length > 0);
    const targetClasses = isTeacherScope ? classes.filter(c => teacherAssignedClasses.includes(c)) : classes;
    const yearStudents = students.filter((s) => (!isTeacherScope || teacherAssignedClasses.includes(s.class)) && (s.academicYear === currentAcademicYear || !s.academicYear) && String(s.class || '').trim().toLowerCase() !== 'alumni' && s.status !== 'alumni' && s.status !== 'graduated');
    const yearRows = examResultsCache.filter((row) => (!isTeacherScope || teacherAssignedClasses.includes(row.classLabel)) && (row.academicYear === currentAcademicYear || !row.academicYear));
    const yearPublishedRows = yearRows.filter((row) => row.published === true);
    document.getElementById('dash-total-classes').textContent = targetClasses.length;
    document.getElementById('dash-total-students').textContent = yearStudents.length;
    
    const statusEl = document.getElementById('dash-publish-status');
    if(resultCenterSettings.publishAt && new Date(resultCenterSettings.publishAt) <= new Date()) {
        statusEl.innerHTML = `<span class="text-emerald-200">Published</span>`;
    } else {
        statusEl.innerHTML = `<span class="text-amber-200">Hidden</span>`;
    }
    const passRows = yearPublishedRows.filter((row) => isPassFromMarks(row));
    const passPercent = yearPublishedRows.length ? Math.round((passRows.length / yearPublishedRows.length) * 100) : 0;
    const passEl = document.getElementById('dash-pass-percent');
    if (passEl) passEl.textContent = `${passPercent}%`;
    const healthLabelEl = document.getElementById('dash-health-label');
    if (healthLabelEl) healthLabelEl.textContent = `${passPercent}%`;
    const healthBarEl = document.getElementById('dash-health-bar');
    if (healthBarEl) healthBarEl.style.width = `${passPercent}%`;

    // 1. Class Performance Breakdown
    const breakdownEl = document.getElementById('dash-class-breakdown');
    if (breakdownEl) {
        if (!targetClasses.length) {
            breakdownEl.innerHTML = '<p class="text-gray-400 text-xs italic">No classes found.</p>';
        } else {
            breakdownEl.innerHTML = targetClasses.map((cls) => {
                const clsRows = yearRows.filter((r) => r.classLabel === cls);
                const clsPublished = clsRows.filter((r) => r.published === true);
                const clsPassed = clsPublished.filter((r) => isPassFromMarks(r));
                const pct = clsPublished.length ? Math.round((clsPassed.length / clsPublished.length) * 100) : 0;
                return `
                    <div class="p-2.5 bg-slate-50 border rounded-xl">
                        <div class="flex justify-between items-center text-xs font-bold text-slate-700 mb-1">
                            <span>${escapeHtml(cls)}</span>
                            <span class="text-indigo-700 font-extrabold">${pct}% <span class="text-[10px] text-slate-400 font-normal">(${clsPassed.length}/${clsPublished.length || clsRows.length})</span></span>
                        </div>
                        <div class="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                            <div class="bg-indigo-600 h-2 rounded-full transition-all duration-300" style="width: ${pct}%"></div>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    // 2. Gender Performance Analytics
    const boysPassEl = document.getElementById('dash-boys-pass');
    const boysPctEl = document.getElementById('dash-boys-pct');
    const girlsPassEl = document.getElementById('dash-girls-pass');
    const girlsPctEl = document.getElementById('dash-girls-pct');
    if (boysPassEl && girlsPassEl) {
        const boysStudents = new Set(yearStudents.filter(s => {
            const g = String(s.gender || '').toLowerCase();
            return g.startsWith('m') || g.includes('boy');
        }).map(s => s.id));
        const girlsStudents = new Set(yearStudents.filter(s => {
            const g = String(s.gender || '').toLowerCase();
            return g.startsWith('f') || g.includes('girl');
        }).map(s => s.id));

        const boysRows = yearPublishedRows.filter(r => boysStudents.has(r.studentId));
        const boysPassed = boysRows.filter(r => isPassFromMarks(r)).length;
        const boysPct = boysRows.length ? Math.round((boysPassed / boysRows.length) * 100) : 0;

        const girlsRows = yearPublishedRows.filter(r => girlsStudents.has(r.studentId));
        const girlsPassed = girlsRows.filter(r => isPassFromMarks(r)).length;
        const girlsPct = girlsRows.length ? Math.round((girlsPassed / girlsRows.length) * 100) : 0;

        boysPassEl.textContent = `${boysPassed} / ${boysRows.length || boysStudents.size}`;
        if (boysPctEl) boysPctEl.textContent = `${boysPct}% Pass Rate`;

        girlsPassEl.textContent = `${girlsPassed} / ${girlsRows.length || girlsStudents.size}`;
        if (girlsPctEl) girlsPctEl.textContent = `${girlsPct}% Pass Rate`;
    }

    // 3. Top Performers Spotlight
    const spotlightEl = document.getElementById('dash-top-performers');
    if (spotlightEl) {
        const topPerClass = [];
        targetClasses.forEach((cls) => {
            const clsRows = (yearPublishedRows.length ? yearPublishedRows : yearRows).filter((r) => r.classLabel === cls && r.totals?.maximum > 0);
            if (clsRows.length) {
                const sorted = [...clsRows].sort((a, b) => Number(b.totals?.obtained || 0) - Number(a.totals?.obtained || 0));
                const top = sorted[0];
                if (top) topPerClass.push({ cls, row: top, student: getStudentById(top.studentId) });
            }
        });
        if (!topPerClass.length) {
            spotlightEl.innerHTML = '<p class="text-gray-400 text-xs italic">Top student ranks will appear once results are entered.</p>';
        } else {
            spotlightEl.innerHTML = topPerClass.map((item) => `
                <div class="flex items-center justify-between p-2.5 bg-amber-50/60 border border-amber-200/70 rounded-xl text-xs">
                    <div class="flex items-center gap-2 min-w-0">
                        <span class="w-6 h-6 rounded-full bg-amber-500 text-white font-extrabold flex items-center justify-center text-[10px] shrink-0">#1</span>
                        <div class="truncate">
                            <span class="font-bold text-slate-800">${escapeHtml(item.student?.name || 'Student')}</span>
                            <span class="text-[10px] text-slate-500 block">${escapeHtml(item.cls)} • Adm: ${escapeHtml(item.student?.adm || item.student?.admissionNo || '-')}</span>
                        </div>
                    </div>
                    <div class="text-right shrink-0">
                        <span class="font-mono font-bold text-amber-900">${item.row.totals?.obtained}/${item.row.totals?.maximum}</span>
                        <span class="text-[10px] text-emerald-700 font-bold block">${Math.round((Number(item.row.totals?.obtained || 0) / Number(item.row.totals?.maximum || 1)) * 100)}%</span>
                    </div>
                </div>
            `).join('');
        }
    }

    const recentExamsEl = document.getElementById('dash-recent-exams');
    const recent = resultSchemas.slice(-3);
    if(recent.length === 0) {
        recentExamsEl.innerHTML = '<p class="text-gray-500 text-sm">No exams created yet.</p>';
    } else {
        recentExamsEl.innerHTML = recent.map(e => `
            <div class="flex justify-between items-center p-3 border rounded-lg bg-gray-50">
                <span class="font-bold text-gray-800">${escapeHtml(e.classLabel || e.name || 'Class Schema')}</span>
                <span class="text-xs bg-indigo-100 text-indigo-800 px-2 py-1 rounded font-bold">${getSchemaSubjectRows(e).length || 0} Subjects</span>
            </div>
        `).join('');
    }
    renderPublishedDraftTables();
    updateReportPreview();
    renderPublishControls();
};

const getStudentNameById = (studentId = '') => students.find((entry) => entry.id === studentId)?.name || 'Unknown';
const getStudentById = (studentId = '') => students.find((entry) => entry.id === studentId) || {};
const getExamNameById = (examId = '', row = {}) => row.examLabel || getExamContext(examId, row.classLabel || '', row.academicYear || currentAcademicYear)?.label || resultSchemas.find((entry) => entry.id === examId)?.name || 'Unknown Exam';
const sortResultRows = (rows = [], order = 'admission') => {
    const wrapped = rows.map((row) => ({ row, student: getStudentById(row.studentId) }));
    return sortReportRows(wrapped, order).map((entry) => entry.row);
};


const hasPAwarded = (row = {}) => {
    const marks = Object.values(row.marks || {});
    return marks.some((m) => getStoredMarkValue(m).toUpperCase() === 'P');
};

const hasAbsentSubject = (row = {}) => {
    const marks = Object.values(row.marks || {});
    if (!marks.length) return false;
    return marks.some((m) => {
        const val = getStoredMarkValue(m).toUpperCase();
        return val === 'A' || val === 'AB';
    });
};

const isAllAbsent = (row = {}) => {
    const marks = Object.values(row.marks || {});
    if (!marks.length) return false;
    return marks.every((m) => {
        const val = getStoredMarkValue(m).toUpperCase();
        return val === 'A' || val === 'AB';
    });
};

const renderPublishedDraftTables = () => {
    const publishedEl = document.getElementById('published-results-table');
    const draftEl = document.getElementById('draft-results-table');
    if (!publishedEl || !draftEl) return;
    const yearRows = examResultsCache.filter((row) => !currentAcademicYear || !row.academicYear || row.academicYear === currentAcademicYear);
    const publishedClass = document.getElementById('published-class-filter')?.value || '';
    const publishedExam = document.getElementById('published-exam-filter')?.value || '';
    const draftClass = document.getElementById('draft-class-filter')?.value || '';
    const draftExam = document.getElementById('draft-exam-filter')?.value || '';

    const isTeacherScope = (roleScope === 'staff' && teacherAssignedClasses.length > 0);

    const publishedRowsRaw = yearRows.filter((row) => row.published === true)
        .filter((row) => !publishedClass || row.classLabel === publishedClass)
        .filter((row) => resultMatchesExam(row, publishedExam));
    const draftRowsRaw = yearRows.filter((row) => row.published !== true)
        .filter((row) => !isTeacherScope || teacherAssignedClasses.includes(row.classLabel))
        .filter((row) => !draftClass || row.classLabel === draftClass)
        .filter((row) => resultMatchesExam(row, draftExam));

    // Update smart filter count badges for Draft
    const elAll = document.getElementById('draft-count-all');
    if (elAll) elAll.textContent = draftRowsRaw.length;
    const elPassed = document.getElementById('draft-count-passed');
    if (elPassed) elPassed.textContent = draftRowsRaw.filter(r => isPassFromMarks(r)).length;
    const elFailed = document.getElementById('draft-count-failed');
    if (elFailed) elFailed.textContent = draftRowsRaw.filter(r => !isPassFromMarks(r) && !isAllAbsent(r)).length;
    const elAbsent = document.getElementById('draft-count-absent');
    if (elAbsent) elAbsent.textContent = draftRowsRaw.filter(r => hasAbsentSubject(r)).length;
    const elPAwarded = document.getElementById('draft-count-p-awarded');
    if (elPAwarded) elPAwarded.textContent = draftRowsRaw.filter(r => hasPAwarded(r)).length;

    // Update smart filter count badges for Published
    const elPubAll = document.getElementById('published-count-all');
    if (elPubAll) elPubAll.textContent = publishedRowsRaw.length;
    const elPubPassed = document.getElementById('published-count-passed');
    if (elPubPassed) elPubPassed.textContent = publishedRowsRaw.filter(r => isPassFromMarks(r)).length;
    const elPubFailed = document.getElementById('published-count-failed');
    if (elPubFailed) elPubFailed.textContent = publishedRowsRaw.filter(r => !isPassFromMarks(r) && !isAllAbsent(r)).length;
    const elPubAbsent = document.getElementById('published-count-absent');
    if (elPubAbsent) elPubAbsent.textContent = publishedRowsRaw.filter(r => hasAbsentSubject(r)).length;
    const elPubPAwarded = document.getElementById('published-count-p-awarded');
    if (elPubPAwarded) elPubPAwarded.textContent = publishedRowsRaw.filter(r => hasPAwarded(r)).length;

    // Filter by active quick filter for Draft
    let filteredDraftRows = draftRowsRaw;
    if (currentDraftFilter === 'passed') {
        filteredDraftRows = draftRowsRaw.filter(r => isPassFromMarks(r));
    } else if (currentDraftFilter === 'failed') {
        filteredDraftRows = draftRowsRaw.filter(r => !isPassFromMarks(r) && !isAllAbsent(r));
    } else if (currentDraftFilter === 'absent') {
        filteredDraftRows = draftRowsRaw.filter(r => hasAbsentSubject(r));
    } else if (currentDraftFilter === 'p_awarded') {
        filteredDraftRows = draftRowsRaw.filter(r => hasPAwarded(r));
    }

    // Filter by active quick filter for Published
    let filteredPublishedRows = publishedRowsRaw;
    if (currentPublishedFilter === 'passed') {
        filteredPublishedRows = publishedRowsRaw.filter(r => isPassFromMarks(r));
    } else if (currentPublishedFilter === 'failed') {
        filteredPublishedRows = publishedRowsRaw.filter(r => !isPassFromMarks(r) && !isAllAbsent(r));
    } else if (currentPublishedFilter === 'absent') {
        filteredPublishedRows = publishedRowsRaw.filter(r => hasAbsentSubject(r));
    } else if (currentPublishedFilter === 'p_awarded') {
        filteredPublishedRows = publishedRowsRaw.filter(r => hasPAwarded(r));
    }

    const publishedOrder = document.getElementById('published-order-filter')?.value || 'admission';
    const draftOrder = document.getElementById('draft-order-filter')?.value || 'admission';
    const publishedRows = sortResultRows(filteredPublishedRows, publishedOrder);
    const draftRows = sortResultRows(filteredDraftRows, draftOrder);

    const adminRowActions = (isPublished, rowId) => `
        <button class="publish-toggle-btn block w-full text-left px-3 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50 flex items-center gap-1.5" data-id="${rowId}" data-next="${isPublished ? 'draft' : 'published'}">
            <i class="fas ${isPublished ? 'fa-arrow-rotate-left text-amber-600' : 'fa-upload text-emerald-600'}"></i> ${isPublished ? 'Move to Draft' : 'Publish'}
        </button>
        <button class="delete-result-btn block w-full text-left px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 flex items-center gap-1.5" data-id="${rowId}">
            <i class="fas fa-trash text-rose-500"></i> Delete
        </button>
    `;

    const renderTableForResults = (rows, isPublished) => {
        if (!rows.length) {
            return `
                <div class="p-8 text-center bg-slate-50 border border-dashed border-slate-200 rounded-xl">
                    <i class="fas ${isPublished ? 'fa-clipboard-check' : 'fa-clipboard-list'} text-3xl text-slate-300 mb-2"></i>
                    <p class="text-sm font-semibold text-slate-600">No ${isPublished ? 'published' : 'draft'} results found.</p>
                    <p class="text-xs text-slate-400 mt-1">No records match the current filter or class selection.</p>
                </div>
            `;
        }

        const tableBodyHtml = rows.map((row, index) => {
            const student = getStudentById(row.studentId) || {};
            const studentName = student.name || getStudentNameById(row.studentId) || row.studentName || 'Unknown Student';
            const admNo = student.admissionNo || student.adm || student.uid || row.admissionNo || '-';
            const gender = String(student.gender || '').trim().toLowerCase();
            const genderBadge = (gender.startsWith('f') || gender.includes('girl'))
                ? '<span class="text-[10px] font-bold text-pink-700 bg-pink-50 border border-pink-200 px-1.5 py-0.5 rounded">Girl</span>'
                : (gender.startsWith('m') || gender.includes('boy'))
                    ? '<span class="text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">Boy</span>'
                    : '';

            const schema = resultSchemas.find((item) => item.id === row.schemaId) || getSchemaForClass(row.academicYear || currentAcademicYear, row.classLabel || '');
            const subjects = getSchemaSubjectRows(schema || {}, row.examKey || parseExamValue(row.examId || '').examKey);
            const marks = row.marks || {};

            const subjectPills = subjects.map((sub) => {
                const markVal = getResultMark(marks, sub);
                const upper = String(markVal || '').trim().toUpperCase();
                let pillClass = 'bg-slate-100 text-slate-700 border-slate-200';
                let displayVal = markVal || '-';
                if (upper === 'P') {
                    pillClass = 'bg-emerald-100 text-emerald-800 border-emerald-300 font-bold';
                    displayVal = 'P';
                } else if (upper === 'A' || upper === 'AB') {
                    pillClass = 'bg-amber-100 text-amber-800 border-amber-300 font-bold';
                    displayVal = 'A';
                } else {
                    const num = Number(markVal);
                    if (Number.isFinite(num)) {
                        if (num >= Number(sub.passMarks || 0)) {
                            pillClass = 'bg-indigo-50 text-indigo-700 border-indigo-200 font-medium';
                        } else {
                            pillClass = 'bg-rose-50 text-rose-700 border-rose-200 font-bold';
                        }
                    }
                }
                return `<span class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border ${pillClass}" title="${escapeHtml(sub.name)}: Pass mark ${sub.passMarks}, Max ${sub.maxMarks}"><span class="text-[10px] text-slate-500 font-normal truncate max-w-[70px]">${escapeHtml(sub.name)}:</span><span class="font-bold">${escapeHtml(String(displayVal))}</span></span>`;
            }).join(' ');

            const isPassed = isPassFromMarks(row);
            const hasP = hasPAwarded(row);
            const isAbs = isAllAbsent(row);

            let statusBadge = '';
            if (isAbs) {
                statusBadge = '<span class="px-2 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-200"><i class="fas fa-user-xmark mr-1"></i>ABSENT</span>';
            } else if (isPassed) {
                statusBadge = '<span class="px-2 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-200"><i class="fas fa-check-circle mr-1"></i>PASS</span>';
            } else {
                statusBadge = '<span class="px-2 py-1 rounded-full text-xs font-bold bg-rose-100 text-rose-800 border border-rose-200"><i class="fas fa-times-circle mr-1"></i>FAIL</span>';
            }

            const pChip = hasP ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-purple-100 text-purple-800 border border-purple-200 ml-1" title="Contains P (Passed) subject">P</span>' : '';

            const obt = Number(row.totals?.obtained ?? 0);
            const max = Number(row.totals?.maximum ?? 0);
            const pct = max > 0 ? Math.round((obt / max) * 100) : 0;

            const checkboxClass = isPublished ? 'published-select-checkbox' : 'draft-select-checkbox';

            return `
            <tr class="hover:bg-slate-50 transition border-b border-slate-100" data-result-id="${escapeHtml(row.id)}">
                <td class="p-3 text-center">
                    <input type="checkbox" class="${checkboxClass} rounded text-indigo-600" value="${escapeHtml(row.id)}">
                </td>
                <td class="p-3 text-center font-mono text-xs text-slate-400 font-semibold">${index + 1}</td>
                <td class="p-3 font-mono text-xs font-bold text-slate-700">${escapeHtml(admNo)}</td>
                <td class="p-3">
                    <div class="font-bold text-slate-800 flex items-center gap-1.5">${escapeHtml(studentName)} ${genderBadge}</div>
                </td>
                <td class="p-3">
                    <div class="text-xs font-semibold text-slate-700">${escapeHtml(row.classLabel || '-')}</div>
                    <div class="text-[10px] text-slate-500">${escapeHtml(getExamNameById(row.examId, row))}</div>
                </td>
                <td class="p-3">
                    <div class="flex flex-wrap gap-1 max-w-md">${subjectPills || '<span class="text-xs text-slate-400 italic">No marks</span>'}</div>
                </td>
                <td class="p-3 text-center">
                    <div class="font-mono text-xs font-bold text-slate-800">${obt} / ${max}</div>
                    <div class="text-[10px] font-semibold text-slate-500">${pct}%</div>
                </td>
                <td class="p-3 text-center whitespace-nowrap">
                    ${statusBadge} ${pChip}
                </td>
                <td class="p-3 text-center">
                    <div class="relative inline-block text-left">
                        <button class="result-row-menu-toggle w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-600 flex items-center justify-center transition" data-id="${row.id}" title="Actions">
                            <i class="fas fa-ellipsis-v"></i>
                        </button>
                        <div class="result-row-menu hidden absolute right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-20 min-w-[130px] py-1" data-id="${row.id}">
                            <button class="edit-result-btn block w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-1.5" data-id="${row.id}">
                                <i class="fas fa-edit text-blue-500"></i> Edit Marks
                            </button>
                            ${roleScope === 'admin' ? adminRowActions(isPublished, row.id) : ''}
                        </div>
                    </div>
                </td>
            </tr>
            `;
        }).join('');

        const selectAllId = isPublished ? 'published-table-select-all' : 'draft-table-select-all';

        return `
            <div class="overflow-x-auto border border-slate-200 rounded-xl shadow-xs bg-white">
                <table class="w-full text-left text-xs whitespace-nowrap">
                    <thead class="bg-slate-50 text-slate-600 font-bold uppercase text-[10px] tracking-wider border-b border-slate-200">
                        <tr>
                            <th class="p-3 w-8 text-center"><input type="checkbox" id="${selectAllId}" class="rounded text-indigo-600" title="Select All"></th>
                            <th class="p-3 w-10 text-center">#</th>
                            <th class="p-3 w-20">Adm No</th>
                            <th class="p-3 min-w-[140px]">Student Name</th>
                            <th class="p-3 min-w-[110px]">Class & Exam</th>
                            <th class="p-3 min-w-[200px]">Subject Breakdown</th>
                            <th class="p-3 text-center min-w-[90px]">Total</th>
                            <th class="p-3 text-center min-w-[90px]">Status</th>
                            <th class="p-3 text-center w-16">Actions</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100">
                        ${tableBodyHtml}
                    </tbody>
                </table>
            </div>
        `;
    };

    publishedEl.innerHTML = renderTableForResults(publishedRows, true);
    draftEl.innerHTML = renderTableForResults(draftRows, false);

    const pubClassEl = document.getElementById('published-class-filter');
    if (pubClassEl) {
        const prev = pubClassEl.value;
        pubClassEl.innerHTML = `<option value="">All Classes</option>${classes.map((cls) => `<option value="${escapeHtml(cls)}">${escapeHtml(cls)}</option>`).join('')}`;
        if (prev) pubClassEl.value = prev;
    }

    const draftClassEl = document.getElementById('draft-class-filter');
    if (draftClassEl) {
        const prevDraft = draftClassEl.value;
        const draftAllowedClasses = isTeacherScope ? classes.filter((c) => teacherAssignedClasses.includes(c)) : classes;
        draftClassEl.innerHTML = (draftAllowedClasses.length === 1)
            ? draftAllowedClasses.map((cls) => `<option value="${escapeHtml(cls)}">${escapeHtml(cls)}</option>`).join('')
            : `<option value="">All Classes</option>${draftAllowedClasses.map((cls) => `<option value="${escapeHtml(cls)}">${escapeHtml(cls)}</option>`).join('')}`;
        if (prevDraft && draftAllowedClasses.includes(prevDraft)) {
            draftClassEl.value = prevDraft;
        } else if (draftAllowedClasses.length === 1) {
            draftClassEl.value = draftAllowedClasses[0];
        }
    }

    renderExamSelectOptions(document.getElementById('published-exam-filter'), publishedClass, currentAcademicYear, 'All Exams');
    renderExamSelectOptions(document.getElementById('draft-exam-filter'), draftClass, currentAcademicYear, 'All Exams');
};

// --- Exam Setup Logic ---
const getAvailableSubjectTotals = (selectedVal) => {
    const scales = getEffectiveGradeScales();
    const totals = new Set(Object.keys(scales).map(Number).filter((n) => Number.isFinite(n) && n > 0));
    totals.add(100);
    totals.add(50);
    if (selectedVal && Number.isFinite(Number(selectedVal)) && Number(selectedVal) > 0) {
        totals.add(Number(selectedVal));
    }
    return Array.from(totals).sort((a, b) => b - a);
};

const refreshSubjectTotalDropdowns = (newTotal) => {
    document.querySelectorAll('#subject-rows-body .subject-total-input').forEach((selectEl) => {
        const currentVal = Number(selectEl.value || 100);
        const availableTotals = getAvailableSubjectTotals(currentVal);
        selectEl.innerHTML = availableTotals.map((val) => `<option value="${val}" ${val === currentVal ? 'selected' : ''}>${val}</option>`).join('');
    });
};

const buildSubjectRowHtml = (row = {}) => {
    const rowMax = Number(row.maxMarks ?? 100);
    const availableTotals = getAvailableSubjectTotals(rowMax);
    const optionsHtml = availableTotals.map((val) => `<option value="${val}" ${val === rowMax ? 'selected' : ''}>${val}</option>`).join('');
    return `
    <tr class="subject-row border-t">
        <td class="p-2"><input type="text" class="subject-name-input w-full p-2 border rounded" value="${escapeHtml(row.name || '')}" placeholder="Subject name"></td>
        <td class="p-2"><select class="subject-total-input w-full p-2 border rounded">${optionsHtml}</select></td>
        <td class="p-2"><input type="number" class="subject-pass-input w-full p-2 border rounded" value="${escapeHtml(String(row.passMarks ?? 35))}" min="0"></td>
        <td class="p-2"><button type="button" class="subject-remove-row text-red-600 font-bold">✕</button></td>
    </tr>
`;
};
const renderExamSetup = () => {
    const cont = document.getElementById('exam-list-container');
    if (!cont) return;
    const isTeacherScope = (roleScope === 'staff' && teacherAssignedClasses.length > 0);
    const classFilter = document.getElementById('schema-list-class-filter')?.value || '';
    const filtered = resultSchemas
        .filter((s) => s.academicYear === currentAcademicYear || !s.academicYear)
        .filter((s) => !isTeacherScope || teacherAssignedClasses.includes(s.classLabel))
        .filter((s) => !classFilter || s.classLabel === classFilter);
    
    if (filtered.length === 0) {
        cont.innerHTML = `
            <div class="text-center py-10 px-4 text-slate-500 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                <i class="fas fa-folder-open text-3xl text-slate-300 mb-2 block"></i>
                <div class="font-bold text-slate-700">No saved subjects or exams found</div>
                <p class="text-xs text-slate-400 mt-1">Select a class above to configure subjects and custom exams for academic year ${escapeHtml(currentAcademicYear || 'current')}.</p>
            </div>
        `;
        return;
    }

    const rowsHtml = filtered.map((schema) => {
        const customExams = Object.entries(getCustomExamConfigs(schema.examConfigs || {}));
        const subjectRows = getSchemaSubjectRows(schema);
        
        const subjectsBadgeHtml = subjectRows.length
            ? subjectRows.map((sub) => `
                <span class="inline-flex items-center gap-1 bg-slate-100 text-slate-800 border border-slate-200 px-2 py-0.5 rounded text-[11px] font-medium mr-1 mb-1">
                    ${escapeHtml(sub.name)} <span class="text-slate-500 font-semibold">(${sub.maxMarks}/${sub.passMarks})</span>
                </span>
            `).join('')
            : '<span class="text-xs text-slate-400 italic">No subjects configured</span>';

        const defaultExamsBadges = DEFAULT_EXAM_DEFS.map((exam) => `
            <span class="inline-flex items-center gap-1 bg-indigo-50 border border-indigo-200 text-indigo-700 px-2 py-0.5 rounded text-[11px] font-semibold mr-1 mb-1">
                ${escapeHtml(exam.label)} <span class="text-[9px] bg-indigo-200 text-indigo-800 px-1 rounded">Default</span>
            </span>
        `).join('');

        const customExamsBadges = customExams.length
            ? customExams.map(([key, config]) => {
                const examLabel = config?.label || key;
                return `
                <span class="inline-flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 text-emerald-800 px-2 py-0.5 rounded text-[11px] font-medium mr-1 mb-1">
                    <span>${escapeHtml(examLabel)}</span>
                    <button type="button" class="custom-exam-edit-btn text-blue-600 hover:text-blue-800 font-bold p-0.5" data-schema-id="${schema.id}" data-exam-key="${escapeHtml(key)}" title="Edit Custom Exam"><i class="fas fa-pen text-[9px]"></i></button>
                    <button type="button" class="custom-exam-delete-btn text-red-600 hover:text-red-800 font-bold p-0.5" data-schema-id="${schema.id}" data-exam-key="${escapeHtml(key)}" title="Delete Custom Exam"><i class="fas fa-times text-[9px]"></i></button>
                </span>
                `;
            }).join('')
            : '';

        return `
        <tr class="hover:bg-slate-50/70 transition border-b border-slate-100">
            <td class="p-3 align-top font-bold text-slate-800 whitespace-nowrap">
                <div class="flex items-center gap-2">
                    <span class="text-sm font-extrabold text-slate-800">${escapeHtml(schema.classLabel || '--')}</span>
                    <span class="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-bold">${subjectRows.length} Subs</span>
                </div>
                <div class="text-[11px] text-slate-400 font-normal mt-0.5">${escapeHtml(schema.academicYear || currentAcademicYear || '')}</div>
            </td>
            <td class="p-3 align-top">
                <div class="flex flex-wrap">${subjectsBadgeHtml}</div>
            </td>
            <td class="p-3 align-top">
                <div class="flex flex-wrap items-center">
                    ${defaultExamsBadges}
                    ${customExamsBadges}
                </div>
            </td>
            <td class="p-3 align-top text-right whitespace-nowrap">
                <div class="flex items-center justify-end gap-1.5">
                    <button type="button" class="schema-edit-btn bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-bold py-1.5 px-2.5 rounded-lg transition flex items-center gap-1" data-id="${schema.id}" title="Edit Subjects">
                        <i class="fas fa-edit"></i> Edit
                    </button>
                    <button type="button" class="schema-configure-exams-btn bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold py-1.5 px-2 rounded-lg transition flex items-center gap-1" data-id="${schema.id}" data-class="${escapeHtml(schema.classLabel)}" title="Configure Exams">
                        <i class="fas fa-tasks"></i> Exams
                    </button>
                    <button type="button" class="schema-delete-btn bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-xs font-bold py-1.5 px-2 rounded-lg transition" data-id="${schema.id}" title="Delete Class Schema">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
            </td>
        </tr>
        `;
    }).join('');

    cont.innerHTML = `
        <table class="w-full text-left text-xs sm:text-sm">
            <thead class="bg-slate-50 text-slate-700 border-b font-semibold">
                <tr>
                    <th class="p-3 w-36">Class</th>
                    <th class="p-3 min-w-[220px]">Subjects (Total/Pass)</th>
                    <th class="p-3 min-w-[220px]">Active Exams</th>
                    <th class="p-3 text-right w-48">Actions</th>
                </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
                ${rowsHtml}
            </tbody>
        </table>
    `;
};

const openExamModal = () => {
    const modal = document.getElementById('exam-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        modal.style.display = 'flex';
    }
    document.body.classList.add('modal-scroll-lock');
};

const closeExamModal = () => {
    const modal = document.getElementById('exam-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        modal.style.display = 'none';
    }
    document.body.classList.remove('modal-scroll-lock');
};

document.getElementById('create-exam-btn')?.addEventListener('click', () => {
    if (roleScope !== 'admin') return alert('Only admin can manage exam setup.');
    editingExamId = null;
    document.getElementById('exam-modal-title').textContent = "Create New Exam";
    document.getElementById('exam-name').value = '';
    document.getElementById('exam-max').value = '50';
    document.getElementById('exam-pass').value = '18';
    document.getElementById('subject-list').innerHTML = `
        <div class="flex gap-2 mb-2 sub-row">
            <input type="text" class="w-full p-2 border rounded-lg text-sm sub-input" placeholder="Subject Name (e.g. English)">
            <button class="text-red-500 px-2 remove-sub-btn"><i class="fas fa-times"></i></button>
        </div>
    `;
    openExamModal();
});

document.getElementById('exam-cancel').addEventListener('click', closeExamModal);

document.getElementById('add-subject-btn').addEventListener('click', () => {
    const div = document.createElement('div');
    div.className = 'flex gap-2 mb-2 sub-row';
    div.innerHTML = `
        <input type="text" class="w-full p-2 border rounded-lg text-sm sub-input" placeholder="Subject Name">
        <button class="text-red-500 px-2 remove-sub-btn"><i class="fas fa-times"></i></button>
    `;
    document.getElementById('subject-list').appendChild(div);
});

document.getElementById('subject-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.remove-sub-btn');
    if(btn) btn.closest('.sub-row').remove();
});

document.getElementById('exam-list-container').addEventListener('click', async (e) => {
    if (roleScope !== 'admin') return;
    const editBtn = e.target.closest('.edit-exam-btn');
    const delBtn = e.target.closest('.del-exam-btn');

    if(editBtn) {
        const exam = resultSchemas.find(s => s.id === editBtn.dataset.id);
        if(!exam) return;
        editingExamId = exam.id;
        document.getElementById('exam-modal-title').textContent = "Edit Exam";
        document.getElementById('exam-name').value = exam.name;
        document.getElementById('exam-max').value = exam.maxMarks || '';
        document.getElementById('exam-pass').value = exam.passMarks || '';
        
        const subHtml = (exam.subjects || []).map(sub => `
            <div class="flex gap-2 mb-2 sub-row">
                <input type="text" class="w-full p-2 border rounded-lg text-sm sub-input" value="${escapeHtml(sub)}">
                <button class="text-red-500 px-2 remove-sub-btn"><i class="fas fa-times"></i></button>
            </div>
        `).join('');
        document.getElementById('subject-list').innerHTML = subHtml || `<div class="flex gap-2 mb-2 sub-row"><input type="text" class="w-full p-2 border rounded-lg text-sm sub-input" placeholder="Subject Name"><button class="text-red-500 px-2 remove-sub-btn"><i class="fas fa-times"></i></button></div>`;
        
        openExamModal();
    }

    if(delBtn) {
        const ok = await showAppConfirm({
            title: 'Delete Exam Schema',
            message: 'Are you sure you want to delete this exam schema? All configured subjects and criteria will be removed.',
            confirmText: 'Delete Schema',
            type: 'danger'
        });
        if (ok) {
            await deleteDoc(doc(db, `${BASE_PATH}/resultSchemas`, delBtn.dataset.id));
            showToast('Exam schema deleted successfully', 'success');
        }
    }
});

document.getElementById('exam-save').addEventListener('click', async () => {
    if (roleScope !== 'admin') return alert('Only admin can save exam setup.');
    const name = document.getElementById('exam-name').value.trim();
    const maxMarks = parseInt(document.getElementById('exam-max').value) || 0;
    const passMarks = parseInt(document.getElementById('exam-pass').value) || 0;
    
    const subjects = Array.from(document.querySelectorAll('.sub-input'))
        .map(input => input.value.trim())
        .filter(val => val !== '');

    if(!name || subjects.length === 0) return alert("Exam name and at least one subject required.");

    const payload = {
        name, maxMarks, passMarks, subjects,
        academicYear: currentAcademicYear,
        updatedAt: Date.now()
    };

    const btn = document.getElementById('exam-save');
    btn.disabled = true;
    btn.innerHTML = "Saving...";

    try {
        if(editingExamId) {
            await updateDoc(doc(db, `${BASE_PATH}/resultSchemas`, editingExamId), payload);
        } else {
            await setDoc(doc(collection(db, `${BASE_PATH}/resultSchemas`)), payload);
        }
        closeExamModal();
    } catch (err) {
        console.error(err);
        alert("Failed to save exam.");
    } finally {
        btn.disabled = false;
        btn.innerHTML = "Save Exam";
    }
});

// --- Marks Entry Logic ---
let entryStudents = [];
let currentExamSchema = null;
let currentExamContext = null;

const sortStudentList = (studentList = [], sortMode = 'name_asc', genderMode = 'mixed') => {
    const list = [...studentList];
    const getAdm = (s) => String(s.adm || s.admissionNo || s.uid || '').trim();
    const getName = (s) => String(s.name || '').trim();
    const getGenderRank = (s, mode) => {
        const g = String(s.gender || '').trim().toLowerCase();
        const isBoy = g.startsWith('m') || g.includes('boy');
        const isGirl = g.startsWith('f') || g.includes('girl');
        if (mode === 'boys_first') {
            if (isBoy) return 0;
            if (isGirl) return 1;
            return 2;
        }
        if (mode === 'girls_first') {
            if (isGirl) return 0;
            if (isBoy) return 1;
            return 2;
        }
        return 0;
    };

    return list.sort((a, b) => {
        if (genderMode !== 'mixed') {
            const grDiff = getGenderRank(a, genderMode) - getGenderRank(b, genderMode);
            if (grDiff !== 0) return grDiff;
        }

        if (sortMode === 'name_asc') {
            return getName(a).localeCompare(getName(b), undefined, { numeric: true, sensitivity: 'base' });
        }
        if (sortMode === 'name_desc') {
            return getName(b).localeCompare(getName(a), undefined, { numeric: true, sensitivity: 'base' });
        }
        if (sortMode === 'adm_asc') {
            return getAdm(a).localeCompare(getAdm(b), undefined, { numeric: true, sensitivity: 'base' }) || getName(a).localeCompare(getName(b));
        }
        if (sortMode === 'adm_desc') {
            return getAdm(b).localeCompare(getAdm(a), undefined, { numeric: true, sensitivity: 'base' }) || getName(a).localeCompare(getName(b));
        }
        return 0;
    });
};

const bindMarksKeyboardNavigation = () => {
    const tableBody = document.getElementById('marks-table-body');
    if (!tableBody || tableBody.dataset.navBound === 'true') return;
    tableBody.dataset.navBound = 'true';
    tableBody.addEventListener('keydown', (e) => {
        const input = e.target.closest('.mark-input, .attendance-working, .attendance-present');
        if (!input) return;
        const currentTd = input.closest('td');
        const currentTr = input.closest('tr');
        if (!currentTd || !currentTr) return;

        const colIndex = Array.from(currentTr.children).indexOf(currentTd);
        const allRows = Array.from(tableBody.querySelectorAll('tr'));
        const rowIndex = allRows.indexOf(currentTr);

        if (e.key === 'ArrowDown' || e.key === 'Enter') {
            e.preventDefault();
            if (rowIndex < allRows.length - 1) {
                const targetTd = allRows[rowIndex + 1].children[colIndex];
                const targetInput = targetTd?.querySelector('.mark-input, .attendance-working, .attendance-present');
                if (targetInput) {
                    targetInput.focus();
                    targetInput.select();
                }
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (rowIndex > 0) {
                const targetTd = allRows[rowIndex - 1].children[colIndex];
                const targetInput = targetTd?.querySelector('.mark-input, .attendance-working, .attendance-present');
                if (targetInput) {
                    targetInput.focus();
                    targetInput.select();
                }
            }
        } else if (e.key === 'ArrowRight' && (input.selectionStart === input.value.length || input.value === '')) {
            const inputsInRow = Array.from(currentTr.querySelectorAll('.mark-input, .attendance-working, .attendance-present'));
            const currentInpIdx = inputsInRow.indexOf(input);
            if (currentInpIdx >= 0 && currentInpIdx < inputsInRow.length - 1) {
                e.preventDefault();
                inputsInRow[currentInpIdx + 1].focus();
                inputsInRow[currentInpIdx + 1].select();
            }
        } else if (e.key === 'ArrowLeft' && (input.selectionStart === 0 || input.value === '')) {
            const inputsInRow = Array.from(currentTr.querySelectorAll('.mark-input, .attendance-working, .attendance-present'));
            const currentInpIdx = inputsInRow.indexOf(input);
            if (currentInpIdx > 0) {
                e.preventDefault();
                inputsInRow[currentInpIdx - 1].focus();
                inputsInRow[currentInpIdx - 1].select();
            }
        }
    });
};

const updateMarkEntryActionButtonsUI = () => {
    const publishBtn = document.getElementById('save-publish-btn');
    if (!publishBtn) return;
    const isCoreExam = isDefaultExamKey(currentExamContext?.key);
    const isAdmin = (roleScope === 'admin');

    if (isAdmin) {
        publishBtn.innerHTML = '<i class="fas fa-upload"></i> Publish';
        publishBtn.className = 'bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-1.5 px-3.5 rounded-lg shadow-sm transition flex items-center gap-1.5 text-xs sm:text-sm';
        publishBtn.title = 'Publish results immediately';
    } else if (isCoreExam) {
        publishBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit to Admin';
        publishBtn.className = 'bg-blue-600 hover:bg-blue-700 text-white font-bold py-1.5 px-3.5 rounded-lg shadow-sm transition flex items-center gap-1.5 text-xs sm:text-sm';
        publishBtn.title = 'Submit marks to Admin for review & publishing';
    } else {
        publishBtn.innerHTML = '<i class="fas fa-upload"></i> Publish';
        publishBtn.className = 'bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-1.5 px-3.5 rounded-lg shadow-sm transition flex items-center gap-1.5 text-xs sm:text-sm';
        publishBtn.title = 'Publish custom exam results for your class';
    }
};

const loadMarksTable = () => {
    const examId = document.getElementById('entry-exam-select').value;
    const className = document.getElementById('entry-class-select').value;
    const cont = document.getElementById('marks-entry-container');

    if(!examId || !className) {
        cont.classList.add('hidden');
        return;
    }

    currentExamContext = getExamContext(examId, className, currentAcademicYear);
    currentExamSchema = currentExamContext?.schema || null;

    updateMarkEntryActionButtonsUI();

    // Capture any user-entered inputs before re-ordering so work isn't lost
    const currentInputValues = {};
    document.querySelectorAll('#marks-table-body tr').forEach((tr) => {
        const sId = tr.dataset.studentid;
        if (!sId) return;
        const sMarks = {};
        tr.querySelectorAll('.mark-input').forEach((inp) => {
            const sub = inp.dataset.subject;
            if (sub) sMarks[sub] = inp.value;
        });
        const work = tr.querySelector('.attendance-working')?.value;
        const pres = tr.querySelector('.attendance-present')?.value;
        currentInputValues[sId] = { marks: sMarks, working: work, present: pres };
    });

    const sortMode = document.getElementById('entry-sort-order')?.value || 'name_asc';
    const genderMode = document.getElementById('entry-gender-order')?.value || 'mixed';
    const rawFiltered = students.filter(s => s.class === className && (s.academicYear === currentAcademicYear || !s.academicYear));
    entryStudents = sortStudentList(rawFiltered, sortMode, genderMode);

    if(!currentExamSchema || entryStudents.length === 0) {
        cont.classList.add('hidden');
        alert("No students found in this class or exam not valid.");
        return;
    }

    document.getElementById('entry-table-title').textContent = `Class: ${className}`;
    document.getElementById('entry-table-subtitle').textContent = `Exam: ${currentExamContext?.label || currentExamSchema.name}`;
    const studentCountBadge = document.getElementById('entry-student-count-badge');
    if (studentCountBadge) studentCountBadge.textContent = `${entryStudents.length} Students`;

    // Build Headers
    let headHtml = `<tr>
        <th class="p-3 text-center w-12 bg-slate-100 text-slate-600 font-bold text-xs sticky top-0 border-b border-slate-200">#</th>
        <th class="p-3 text-left min-w-[95px] bg-slate-100 text-slate-600 font-bold text-xs sticky top-0 border-b border-slate-200">Adm No</th>
        <th class="p-3 text-left min-w-[170px] bg-slate-100 text-slate-600 font-bold text-xs sticky top-0 border-b border-slate-200">Student Name</th>`;
    getSchemaSubjectRows(currentExamSchema, currentExamContext?.key || '').forEach(sub => {
        headHtml += `<th class="p-3 text-center min-w-[95px] bg-slate-100 text-slate-700 font-bold text-xs sticky top-0 border-b border-slate-200">${escapeHtml(sub.name)}<div class="text-[10px] text-slate-400 font-normal">Max: ${sub.maxMarks} | Pass: ${sub.passMarks}</div></th>`;
    });
    headHtml += `<th class="p-3 text-center min-w-[110px] bg-slate-100 text-slate-600 font-bold text-xs sticky top-0 border-b border-slate-200">Total Att.</th><th class="p-3 text-center min-w-[110px] bg-slate-100 text-slate-600 font-bold text-xs sticky top-0 border-b border-slate-200">Present Att.</th></tr>`;
    document.getElementById('marks-table-head').innerHTML = headHtml;

    // Build Rows
    let bodyHtml = '';
    entryStudents.forEach((student, index) => {
        const existingRecord = examResultsCache.find(r => resultMatchesExam(r, examId) && r.studentId === student.id);
        const savedMarksObj = existingRecord ? (existingRecord.marks || {}) : {};
        const pendingInput = currentInputValues[student.id];

        const admNo = student.adm || student.admissionNo || student.uid || '-';
        const g = String(student.gender || '').trim().toLowerCase();
        const genderBadge = (g.startsWith('f') || g.includes('girl'))
            ? '<span class="text-[10px] font-bold text-pink-700 bg-pink-50 border border-pink-200 px-1.5 py-0.5 rounded ml-1">F</span>'
            : (g.startsWith('m') || g.includes('boy'))
                ? '<span class="text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded ml-1">M</span>'
                : '';

        bodyHtml += `<tr class="border-b hover:bg-slate-50 transition" data-studentid="${student.id}">
            <td class="p-3 text-center font-mono text-gray-400 text-xs">${index + 1}</td>
            <td class="p-3 font-mono text-xs font-bold text-slate-600">${escapeHtml(admNo)}</td>
            <td class="p-3 font-bold text-gray-800 text-sm whitespace-nowrap"><div class="flex items-center">${escapeHtml(student.name)} ${genderBadge}</div></td>`;
        
        getSchemaSubjectRows(currentExamSchema, currentExamContext?.key || '').forEach(sub => {
            let val = '';
            if (pendingInput && pendingInput.marks && pendingInput.marks[sub.id] !== undefined) {
                val = pendingInput.marks[sub.id];
            } else {
                const rawMark = savedMarksObj[sub.id] ?? savedMarksObj[sub.name] ?? '';
                val = rawMark && typeof rawMark === 'object' ? (rawMark.value ?? rawMark.mark ?? '') : rawMark;
            }
            bodyHtml += `<td class="p-2 text-center">
                <input type="text" data-subject="${escapeHtml(sub.id)}" data-subject-name="${escapeHtml(sub.name)}" data-max="${sub.maxMarks}" data-pass="${sub.passMarks}" class="mark-input w-full md:w-20 p-2 text-center font-bold text-sm border rounded focus:border-indigo-500 focus:bg-indigo-50 outline-none transition" value="${escapeHtml(String(val ?? ''))}" placeholder="-">
            </td>`;
        });
        const attendance = existingRecord?.attendance || {};
        const workVal = (pendingInput && pendingInput.working !== undefined) ? pendingInput.working : (attendance.workingDays ?? '');
        const presVal = (pendingInput && pendingInput.present !== undefined) ? pendingInput.present : (attendance.presentDays ?? '');

        bodyHtml += `<td class="p-2 text-center"><input type="number" min="0" class="attendance-working w-full md:w-24 p-2 text-center border rounded text-xs" value="${escapeHtml(String(workVal ?? ''))}" placeholder="0"></td>`;
        bodyHtml += `<td class="p-2 text-center"><input type="number" min="0" class="attendance-present w-full md:w-24 p-2 text-center border rounded text-xs" value="${escapeHtml(String(presVal ?? ''))}" placeholder="0"></td>`;
        bodyHtml += `</tr>`;
    });
    document.getElementById('marks-table-body').innerHTML = bodyHtml;
    cont.classList.remove('hidden');
    bindMarksValidationEvents();
    bindMarksKeyboardNavigation();
};
const sanitizeBulkDocId = (value = '') => String(value || '').replace(/[^\w-]/g, '_');
const getBulkTemplateRows = () => {
    const className = document.getElementById('entry-class-select')?.value || '';
    const examId = document.getElementById('entry-exam-select')?.value || '';
    if (!className || !examId || !currentExamSchema) return [];
    const scopedStudents = students
        .filter((s) => s.class === className && (s.academicYear === currentAcademicYear || !s.academicYear))
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const subjectRows = getSchemaSubjectRows(currentExamSchema, currentExamContext?.key || '');
    return scopedStudents.map((student) => {
        const row = {
            student_id: student.id,
            student_name: student.name || '',
            class: className,
            total_attendance: '',
            present_attendance: ''
        };
        subjectRows.forEach((subject) => { row[subject.name] = ''; });
        return row;
    });
};
const downloadBlob = (content, filename, type = 'text/plain') => {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
};
const csvEscape = (value = '') => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const downloadMarksTemplate = (asXlsx = false) => {
    if (!currentExamSchema || !document.getElementById('entry-class-select')?.value || !document.getElementById('entry-exam-select')?.value) {
        alert('Select class and exam first.');
        return;
    }
    const rows = getBulkTemplateRows();
    if (!rows.length) return alert('No students found for selected class.');
    const examLabel = (currentExamContext?.label || currentExamContext?.key || 'exam').replace(/\s+/g, '_');
    const classLabel = (document.getElementById('entry-class-select')?.value || 'class').replace(/\s+/g, '_');
    if (!asXlsx) {
        const headers = Object.keys(rows[0]);
        const csv = [headers.map(csvEscape).join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))].join('\n');
        downloadBlob(csv, `marks_template_${classLabel}_${examLabel}.csv`, 'text/csv;charset=utf-8');
        return;
    }
    if (!window.XLSX) return alert('Spreadsheet library is still loading. Try again in a moment, or download CSV.');
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'marks_template');
    XLSX.writeFile(wb, `marks_template_${classLabel}_${examLabel}.xlsx`, { bookType: 'xlsx' });
};
function updateMarksDownloadAndUploadState() {
    const classVal = document.getElementById('entry-class-select')?.value || '';
    const examVal = document.getElementById('entry-exam-select')?.value || '';
    const isBothSelected = Boolean(classVal && examVal);

    const csvBtn = document.getElementById('marks-template-csv-btn');
    const xlsxBtn = document.getElementById('marks-template-xlsx-btn');
    const fileInput = document.getElementById('marks-bulk-file');
    const uploadBtn = document.getElementById('marks-bulk-upload-btn');

    if (csvBtn) {
        csvBtn.disabled = !isBothSelected;
        csvBtn.classList.toggle('opacity-50', !isBothSelected);
        csvBtn.classList.toggle('cursor-not-allowed', !isBothSelected);
        csvBtn.classList.toggle('cursor-pointer', isBothSelected);
        csvBtn.classList.toggle('text-slate-400', !isBothSelected);
        csvBtn.classList.toggle('text-slate-700', isBothSelected);
    }

    if (xlsxBtn) {
        xlsxBtn.disabled = !isBothSelected;
        xlsxBtn.classList.toggle('opacity-50', !isBothSelected);
        xlsxBtn.classList.toggle('cursor-not-allowed', !isBothSelected);
        xlsxBtn.classList.toggle('cursor-pointer', isBothSelected);
        xlsxBtn.classList.toggle('text-slate-400', !isBothSelected);
        xlsxBtn.classList.toggle('text-slate-700', isBothSelected);
    }

    if (fileInput) {
        fileInput.disabled = !isBothSelected;
        fileInput.classList.toggle('opacity-50', !isBothSelected);
        fileInput.classList.toggle('cursor-not-allowed', !isBothSelected);
    }

    if (uploadBtn) {
        uploadBtn.disabled = !isBothSelected;
        uploadBtn.classList.toggle('opacity-50', !isBothSelected);
        uploadBtn.classList.toggle('cursor-not-allowed', !isBothSelected);
        uploadBtn.classList.toggle('cursor-pointer', isBothSelected);
        if (isBothSelected) {
            uploadBtn.className = 'bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm cursor-pointer';
        } else {
            uploadBtn.className = 'bg-gray-200 text-gray-400 px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-xs opacity-50 cursor-not-allowed';
        }
    }
};

const updateBulkStatus = (message = '', percent = 0, type = 'info') => {
    const statusEl = document.getElementById('marks-bulk-status');
    const progressEl = document.getElementById('marks-bulk-progress');
    const pctEl = document.getElementById('marks-bulk-percent');
    const iconEl = document.getElementById('marks-bulk-status-icon');
    if (statusEl) {
        statusEl.textContent = message;
        statusEl.className = `font-semibold truncate text-xs ${type === 'error' ? 'text-red-600' : type === 'success' ? 'text-emerald-700' : 'text-slate-700'}`;
    }
    if (pctEl) {
        pctEl.textContent = `${Math.round(percent)}%`;
        pctEl.className = `font-extrabold shrink-0 font-mono text-xs ${type === 'error' ? 'text-red-600' : type === 'success' ? 'text-emerald-700' : 'text-indigo-700'}`;
    }
    if (iconEl) {
        iconEl.innerHTML = type === 'error' ? '<i class="fas fa-circle-exclamation text-red-500"></i>'
            : type === 'success' ? '<i class="fas fa-circle-check text-emerald-500"></i>'
            : (percent > 0 && percent < 100) ? '<i class="fas fa-spinner fa-spin text-indigo-500"></i>'
            : '<i class="fas fa-file-import text-indigo-500"></i>';
    }
    if (progressEl) {
        progressEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        progressEl.className = `${type === 'error' ? 'bg-red-500' : type === 'success' ? 'bg-emerald-500' : 'bg-indigo-600'} h-2.5 rounded-full transition-all duration-300`;
    }
};

// --- Marks Bulk Upload Review & Conflict System ---
let currentMarksReviewData = null;

const closeMarksReviewModal = () => {
    const modal = document.getElementById('marks-upload-review-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        modal.style.display = 'none';
    }
    document.body.classList.remove('modal-scroll-lock');
    currentMarksReviewData = null;
    const fileInput = document.getElementById('marks-bulk-file');
    if (fileInput) fileInput.value = '';
};

const openMarksReviewModal = () => {
    const modal = document.getElementById('marks-upload-review-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        modal.style.display = 'flex';
    }
    document.body.classList.add('modal-scroll-lock');
};

const renderMarksReviewModalUI = () => {
    if (!currentMarksReviewData) return;
    const { className, subjectRows, rows, totalRows, validCount, issueRowCount, totalBlankFields, existingRowCount } = currentMarksReviewData;

    const examTitle = currentExamContext?.label || currentExamContext?.key || 'Exam';
    const titleEl = document.getElementById('marks-review-modal-title');
    const subtitleEl = document.getElementById('marks-review-modal-subtitle');
    if (titleEl) titleEl.textContent = `Review Marks Upload - Class ${className} (${examTitle})`;
    if (subtitleEl) subtitleEl.textContent = `Academic Year: ${currentAcademicYear || 'N/A'} • ${totalRows} records loaded from file.`;

    const totalEl = document.getElementById('marks-review-stat-total');
    const validEl = document.getElementById('marks-review-stat-valid');
    const issuesEl = document.getElementById('marks-review-stat-issues');
    const blanksEl = document.getElementById('marks-review-stat-blanks');
    const existingEl = document.getElementById('marks-review-stat-existing');

    if (totalEl) totalEl.textContent = totalRows;
    if (validEl) validEl.textContent = validCount;
    if (issuesEl) issuesEl.textContent = issueRowCount;
    if (blanksEl) blanksEl.textContent = totalBlankFields;
    if (existingEl) existingEl.textContent = existingRowCount;

    // Existing Records Conflict Container
    const conflictContainer = document.getElementById('marks-review-conflict-container');
    if (conflictContainer) {
        if (existingRowCount > 0) {
            conflictContainer.classList.remove('opacity-50');
        } else {
            conflictContainer.classList.add('opacity-50');
        }
    }

    // Buttons
    const skipBtn = document.getElementById('marks-review-skip-issues-btn');
    const skipCountEl = document.getElementById('marks-review-skip-count');
    if (skipBtn && skipCountEl) {
        if (issueRowCount > 0 && validCount > 0) {
            skipBtn.classList.remove('hidden');
            skipCountEl.textContent = validCount;
        } else {
            skipBtn.classList.add('hidden');
        }
    }

    const confirmBtn = document.getElementById('marks-review-confirm-upload-btn');
    const confirmLabel = document.getElementById('marks-review-confirm-upload-label');
    if (confirmBtn && confirmLabel) {
        confirmLabel.textContent = `Start Upload (${validCount})`;
        confirmBtn.disabled = validCount === 0;
        confirmBtn.classList.toggle('opacity-50', validCount === 0);
        confirmBtn.classList.toggle('cursor-not-allowed', validCount === 0);
    }

    // Render Preview Table
    const container = document.getElementById('marks-review-table-container');
    if (!container) return;

    let tableHtml = `
        <table class="w-full text-xs text-left text-slate-700 border-collapse bg-white">
            <thead class="bg-slate-100 text-slate-700 font-bold uppercase sticky top-0 z-10 shadow-xs border-b border-slate-300">
                <tr>
                    <th class="p-2.5 border-b border-r border-slate-200 text-center w-12 bg-slate-100">#</th>
                    <th class="p-2.5 border-b border-r border-slate-200 min-w-[85px] bg-slate-100">Status</th>
                    <th class="p-2.5 border-b border-r border-slate-200 min-w-[100px] bg-slate-100">Adm No</th>
                    <th class="p-2.5 border-b border-r border-slate-200 min-w-[160px] bg-slate-100">Student Name</th>
                    <th class="p-2.5 border-b border-r border-slate-200 min-w-[80px] text-center bg-slate-100">Total Att.</th>
                    <th class="p-2.5 border-b border-r border-slate-200 min-w-[80px] text-center bg-slate-100">Pres. Att.</th>
    `;

    subjectRows.forEach((sub) => {
        tableHtml += `<th class="p-2.5 border-b border-r border-slate-200 text-center min-w-[110px] bg-slate-100">
            ${escapeHtml(sub.name)}
            <div class="text-[10px] text-slate-400 font-normal">Max: ${sub.maxMarks} | Pass: ${sub.passMarks}</div>
        </th>`;
    });

    tableHtml += `</tr></thead><tbody class="divide-y divide-slate-100">`;

    rows.forEach((r) => {
        let rowBg = 'hover:bg-slate-50';
        let statusBadge = '';

        if (r.hasFatalError) {
            rowBg = 'bg-rose-50/60 hover:bg-rose-100/60';
            statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-200 text-rose-800" title="${escapeHtml(r.rowIssues.join('; '))}">ISSUE</span>`;
        } else if (r.isDuplicate) {
            rowBg = 'bg-sky-50/60 hover:bg-sky-100/60';
            statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-sky-200 text-sky-800" title="Marks already exist for this student">EXISTING</span>`;
        } else {
            statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800">READY</span>`;
        }

        tableHtml += `
            <tr class="${rowBg}">
                <td class="p-2.5 text-center text-slate-400 border-b border-r border-slate-100 font-mono">${r.rowIndex}</td>
                <td class="p-2.5 border-b border-r border-slate-100 whitespace-nowrap">${statusBadge}</td>
                <td class="p-2.5 border-b border-r border-slate-100 font-mono font-semibold text-slate-600">${escapeHtml(r.admNo)}</td>
                <td class="p-2.5 border-b border-r border-slate-100 font-bold text-slate-800">${escapeHtml(r.studentName)}</td>
                <td class="p-2.5 border-b border-r border-slate-100 text-center font-mono">${r.attendance.workingDays || '--'}</td>
                <td class="p-2.5 border-b border-r border-slate-100 text-center font-mono">${r.attendance.presentDays || '--'}</td>
        `;

        subjectRows.forEach((sub) => {
            const fStatus = r.fieldStatuses[sub.id] || { status: 'blank', value: '--' };
            let cellClass = 'p-2.5 border-b border-r border-slate-100 text-center font-mono ';
            let cellTitle = '';

            if (fStatus.status === 'error') {
                cellClass += 'bg-rose-100 text-rose-900 font-bold border-rose-300';
                cellTitle = fStatus.reason || 'Invalid mark';
            } else if (fStatus.status === 'blank') {
                cellClass += 'bg-amber-100 text-amber-900 border-amber-200 italic font-semibold';
                cellTitle = 'Blank / Not entered';
            } else {
                cellClass += 'font-semibold text-slate-700';
            }

            tableHtml += `<td class="${cellClass}" title="${escapeHtml(cellTitle)}">${escapeHtml(fStatus.value)}</td>`;
        });

        tableHtml += `</tr>`;
    });

    tableHtml += `</tbody></table>`;
    container.innerHTML = tableHtml;
};

const parseAndReviewBulkMarks = async () => {
    const className = document.getElementById('entry-class-select')?.value || '';
    const examId = document.getElementById('entry-exam-select')?.value || '';
    const file = document.getElementById('marks-bulk-file')?.files?.[0];
    if (!className || !examId) return alert('Select class and exam first.');
    if (roleScope === 'staff' && teacherAssignedClasses.length > 0 && !teacherAssignedClasses.includes(className)) {
        return alert('You can only upload marks for your assigned classes.');
    }
    if (!file) return alert('Choose a spreadsheet file (.csv or .xlsx) first.');
    if (!currentExamSchema) return alert('Schema not loaded for selected exam.');
    if (!window.XLSX) return alert('Spreadsheet library is still loading. Try again in a moment.');

    updateBulkStatus('Reading spreadsheet file...', 20);

    const subjectRows = getSchemaSubjectRows(currentExamSchema, currentExamContext?.key || '');
    if (!subjectRows.length) return alert('No subjects configured for this class and exam.');

    const scopedStudents = students.filter((s) => s.class === className && (s.academicYear === currentAcademicYear || !s.academicYear));
    const studentMap = new Map();
    const admMap = new Map();
    scopedStudents.forEach((s) => {
        if (s.id) studentMap.set(String(s.id).trim(), s);
        const adm = String(s.adm || s.admissionNo || s.uid || '').trim();
        if (adm) admMap.set(adm, s);
    });

    const existingRecordMap = new Map();
    examResultsCache.forEach((rec) => {
        if (resultMatchesExam(rec, examId) && rec.classLabel === className && (!rec.academicYear || rec.academicYear === currentAcademicYear)) {
            existingRecordMap.set(String(rec.studentId).trim(), rec);
        }
    });

    let rawRows = [];
    try {
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const firstSheetName = wb.SheetNames[0];
        if (!firstSheetName) throw new Error('Spreadsheet has no sheets');
        rawRows = XLSX.utils.sheet_to_json(wb.Sheets[firstSheetName], { defval: '' });
    } catch (err) {
        console.error('Error reading spreadsheet', err);
        updateBulkStatus('Failed to read spreadsheet file', 100, 'error');
        alert('Could not read file. Please ensure it is a valid Excel (.xlsx) or CSV file.');
        return;
    }

    if (!rawRows.length) {
        updateBulkStatus('File is empty', 100, 'error');
        return alert('The selected file contains no data rows.');
    }

    updateBulkStatus('Analyzing records and verifying marks...', 50);

    let totalBlankFields = 0;
    let totalIssueFields = 0;
    let validCount = 0;
    let issueRowCount = 0;
    let existingRowCount = 0;

    const parsedRows = rawRows.map((row, index) => {
        const rawStudentId = String(row.student_id ?? row.studentId ?? row.STUDENT_ID ?? row.id ?? '').trim();
        const rawAdm = String(row.adm ?? row.admission_no ?? row.admissionNo ?? row.roll_no ?? '').trim();
        const rawName = String(row.student_name ?? row.studentName ?? row.name ?? '').trim();

        // Match student
        let matchedStudent = studentMap.get(rawStudentId);
        if (!matchedStudent && rawAdm && admMap.has(rawAdm)) {
            matchedStudent = admMap.get(rawAdm);
        }
        if (!matchedStudent && rawName) {
            matchedStudent = scopedStudents.find((s) => (s.name || '').trim().toLowerCase() === rawName.toLowerCase());
        }

        const studentId = matchedStudent ? matchedStudent.id : (rawStudentId || rawAdm);
        const studentName = matchedStudent ? (matchedStudent.name || rawName) : (rawName || 'Unknown Student');
        const admNo = matchedStudent ? (matchedStudent.adm || matchedStudent.admissionNo || matchedStudent.uid || rawAdm || '-') : (rawAdm || '-');

        const rowIssues = [];
        let hasFatalError = false;

        if (!studentId) {
            rowIssues.push('Missing Student ID');
            hasFatalError = true;
        } else if (!matchedStudent) {
            rowIssues.push(`Student not found in Class ${className}`);
            hasFatalError = true;
        }

        const isDuplicate = Boolean(studentId && existingRecordMap.has(String(studentId)));
        if (isDuplicate) {
            existingRowCount++;
        }

        // Attendance
        const rawTotalAtt = row.total_attendance ?? row.working_days ?? row.workingDays ?? '';
        const rawPresAtt = row.present_attendance ?? row.present_days ?? row.presentDays ?? '';
        const workingDays = Number(rawTotalAtt);
        const presentDays = Number(rawPresAtt);

        // Subject mark evaluation
        const marks = {};
        const fieldStatuses = {};

        subjectRows.forEach((sub) => {
            const rawVal = row[sub.name] ?? row[sub.id] ?? row[sub.name.toLowerCase()] ?? '';
            const val = String(rawVal ?? '').trim();

            if (val === '') {
                fieldStatuses[sub.id] = { status: 'blank', value: '--' };
                totalBlankFields++;
            } else {
                const upper = val.toUpperCase();
                const numeric = Number(val);
                const max = Number(sub.maxMarks || 100);
                const pass = Number(sub.passMarks || 35);
                const isValid = upper === 'P' || upper === 'A' || upper === 'AB' || (Number.isFinite(numeric) && numeric >= 0 && numeric <= max);

                if (isValid) {
                    marks[sub.id] = { value: val, name: sub.name, maxMarks: max, passMarks: pass };
                    fieldStatuses[sub.id] = { status: 'valid', value: val };
                } else {
                    hasFatalError = true;
                    totalIssueFields++;
                    const reason = `Invalid mark "${val}". Must be 0-${max}, P, or A`;
                    fieldStatuses[sub.id] = { status: 'error', value: val, reason };
                    rowIssues.push(`${sub.name}: ${reason}`);
                }
            }
        });

        if (hasFatalError) {
            issueRowCount++;
        } else {
            validCount++;
        }

        return {
            rowIndex: index + 1,
            studentId,
            studentName,
            admNo,
            matchedStudent,
            isDuplicate,
            hasFatalError,
            rowIssues,
            marks,
            fieldStatuses,
            attendance: {
                workingDays: Number.isFinite(workingDays) ? workingDays : 0,
                presentDays: Number.isFinite(presentDays) ? presentDays : 0
            }
        };
    });

    currentMarksReviewData = {
        className,
        examId,
        subjectRows,
        rows: parsedRows,
        totalRows: parsedRows.length,
        validCount,
        issueRowCount,
        totalBlankFields,
        totalIssueFields,
        existingRowCount
    };

    renderMarksReviewModalUI();
    openMarksReviewModal();
    updateBulkStatus(`Spreadsheet parsed: ${validCount} valid records, ${issueRowCount} issues found.`, 100, issueRowCount > 0 ? 'info' : 'success');
};

const executeConfirmedMarksUpload = async (skipIssues = false) => {
    if (!currentMarksReviewData) return;
    const { className, examId, subjectRows, rows } = currentMarksReviewData;

    let targetRows = skipIssues ? rows.filter((r) => !r.hasFatalError) : rows;
    if (!skipIssues && targetRows.some((r) => r.hasFatalError)) {
        return alert('Please resolve issues or click "Skip Issues & Upload Valid" to proceed with valid records only.');
    }

    if (!targetRows.length) {
        return alert('No valid student records to upload.');
    }

    // Conflict Resolution for Existing Records
    const duplicateAction = document.querySelector('input[name="marks-duplicate-action"]:checked')?.value || 'merge';
    if (duplicateAction === 'skip') {
        targetRows = targetRows.filter((r) => !r.isDuplicate);
        if (!targetRows.length) {
            closeMarksReviewModal();
            return alert('All records in this file already exist in this class and you chose "Skip Existing". No new records were uploaded.');
        }
    }

    const confirmBtn = document.getElementById('marks-review-confirm-upload-btn');
    const oldBtnHtml = confirmBtn ? confirmBtn.innerHTML : '';
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
    }

    try {
        const chunkSize = 100;
        let committedCount = 0;

        for (let i = 0; i < targetRows.length; i += chunkSize) {
            const chunk = targetRows.slice(i, i + chunkSize);
            const batch = writeBatch(db);

            chunk.forEach((entry) => {
                const docId = sanitizeBulkDocId(`${currentExamSchema.id}_${currentExamContext?.key || ''}_${entry.studentId}`);
                let finalMarks = entry.marks;

                // Merge strategy: if student already has marks in system, merge new marks over existing
                if (duplicateAction === 'merge' && entry.isDuplicate) {
                    const existingRec = examResultsCache.find((r) => resultMatchesExam(r, examId) && r.studentId === entry.studentId);
                    if (existingRec && existingRec.marks) {
                        finalMarks = Object.assign({}, existingRec.marks, entry.marks);
                    }
                }

                const summary = buildResultSummary(finalMarks, subjectRows);
                batch.set(doc(db, `${BASE_PATH}/examResults`, docId), {
                    id: docId,
                    examId,
                    schemaId: currentExamSchema.id,
                    examKey: currentExamContext?.key || '',
                    examType: currentExamContext?.key || '',
                    examLabel: currentExamContext?.label || '',
                    classLabel: className,
                    academicYear: currentAcademicYear || '',
                    studentId: entry.studentId,
                    marks: finalMarks,
                    attendance: entry.attendance,
                    grades: summary.grades,
                    totals: summary.totals,
                    showMarksToStudents: true,
                    updatedAt: Date.now(),
                    published: false
                }, { merge: true });
                committedCount++;
            });

            await batch.commit();
            const pct = Math.round(((i + chunk.length) / targetRows.length) * 100);
            updateBulkStatus(`Uploaded ${committedCount} of ${targetRows.length}...`, pct);
        }

        closeMarksReviewModal();
        updateBulkStatus(`Uploaded ${committedCount} row(s) successfully as draft.`, 100, 'success');
        loadMarksTable();
        notify(`Successfully uploaded ${committedCount} result record(s) into Draft for Class ${className}!`, 'success');
    } catch (err) {
        console.error('Error committing marks', err);
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = oldBtnHtml;
        }
        alert('Upload failed: ' + (err.message || 'Please check your connection and try again.'));
    }
};

// Event Listeners for Marks Entry controls & review modal
document.getElementById('entry-exam-select')?.addEventListener('change', () => {
    updateMarksDownloadAndUploadState();
    loadMarksTable();
});

document.getElementById('entry-class-select')?.addEventListener('change', () => {
    const examSelect = document.getElementById('entry-exam-select');
    renderExamSelectOptions(examSelect, document.getElementById('entry-class-select')?.value || '', currentAcademicYear);
    if (examSelect) examSelect.value = '';
    updateMarksDownloadAndUploadState();
    loadMarksTable();
});

document.getElementById('marks-template-csv-btn')?.addEventListener('click', () => downloadMarksTemplate(false));
document.getElementById('marks-template-xlsx-btn')?.addEventListener('click', () => downloadMarksTemplate(true));

document.getElementById('marks-bulk-file')?.addEventListener('change', () => {
    const file = document.getElementById('marks-bulk-file')?.files?.[0];
    if (file) {
        parseAndReviewBulkMarks();
    }
});

document.getElementById('marks-bulk-upload-btn')?.addEventListener('click', async () => {
    try {
        await parseAndReviewBulkMarks();
    } catch (error) {
        console.error('Bulk marks review failed', error);
        updateBulkStatus(`Review failed: ${error?.message || 'Check file format and try again.'}`, 100, 'error');
        alert('File review failed. Check file format and try again.');
    }
});

document.getElementById('marks-review-modal-close-x')?.addEventListener('click', closeMarksReviewModal);
document.getElementById('marks-review-cancel-btn')?.addEventListener('click', closeMarksReviewModal);
document.getElementById('marks-review-skip-issues-btn')?.addEventListener('click', () => executeConfirmedMarksUpload(true));
document.getElementById('marks-review-confirm-upload-btn')?.addEventListener('click', () => executeConfirmedMarksUpload(false));


const validateSingleMarkInput = (input) => {
    if (!input || !currentExamSchema) return true;
    const raw = String(input.value || '').trim().toUpperCase();
    if (!raw) {
        input.classList.remove('input-error');
        return true;
    }
    if (raw === 'A' || raw === 'AB' || raw === 'P') {
        input.classList.remove('input-error');
        return true;
    }
    const asNum = Number(raw);
    const max = Number(input.dataset.max || currentExamSchema.maxMarks || 0);
    const valid = Number.isFinite(asNum) && asNum >= 0 && asNum <= max;
    input.classList.toggle('input-error', !valid);
    return valid;
};
const validateMarksTable = () => {
    const inputs = Array.from(document.querySelectorAll('#marks-table-body .mark-input'));
    const allValid = inputs.every((input) => validateSingleMarkInput(input));
    document.getElementById('marks-validation-note')?.classList.toggle('hidden', allValid);
    return allValid;
};
const bindMarksValidationEvents = () => {
    const tableBody = document.getElementById('marks-table-body');
    if (!tableBody) return;
    if (tableBody.dataset.validationBound !== 'true') {
        tableBody.dataset.validationBound = 'true';
        tableBody.addEventListener('input', (e) => {
            const input = e.target.closest('.mark-input');
            if (input) {
                validateSingleMarkInput(input);
                const hasError = Boolean(tableBody.querySelector('.mark-input.input-error'));
                document.getElementById('marks-validation-note')?.classList.toggle('hidden', !hasError);
            }
        });
    }
    validateMarksTable();
};

const saveMarksFromEntry = async (shouldPublish = false) => {
    if(!currentExamSchema || !currentExamContext) return;
    if(!validateMarksTable()) return alert('Please fix invalid marks before saving.');

    const selectedClass = document.getElementById('entry-class-select')?.value || '';
    if (roleScope === 'staff' && teacherAssignedClasses.length > 0 && !teacherAssignedClasses.includes(selectedClass)) {
        return alert('You can only enter marks for your assigned classes.');
    }

    const isCoreExam = isDefaultExamKey(currentExamContext?.key);
    const isAdmin = (roleScope === 'admin');
    const isTeacherCustomPublish = (!isAdmin && !isCoreExam && shouldPublish);
    const isTeacherCoreSubmit = (!isAdmin && isCoreExam && shouldPublish);
    const effectivePublish = shouldPublish && (isAdmin || isTeacherCustomPublish);
    
    const rows = document.querySelectorAll('#marks-table-body tr');
    const subjectRows = getSchemaSubjectRows(currentExamSchema, currentExamContext?.key || '');
    const batch = writeBatch(db);
    let operationCount = 0;

    rows.forEach(row => {
        const studentId = row.dataset.studentid;
        const marks = {};
        let hasData = false;

        row.querySelectorAll('.mark-input').forEach(input => {
            const sub = input.dataset.subject;
            const val = input.value.trim();
            if(val !== '') {
                marks[sub] = { value: val, name: input.dataset.subjectName || sub, maxMarks: Number(input.dataset.max || 0), passMarks: Number(input.dataset.pass || 0) };
                hasData = true;
            }
        });

        const docId = `${currentExamSchema.id}_${currentExamContext.key}_${studentId}`.replace(/[^\w-]/g, '_');
        const ref = doc(db, `${BASE_PATH}/examResults`, docId);

        if(hasData) {
            const workingDays = Number(row.querySelector('.attendance-working')?.value || 0);
            const presentDays = Number(row.querySelector('.attendance-present')?.value || 0);
            const summary = buildResultSummary(marks, subjectRows);
            const recordPayload = {
                examId: currentExamContext.value,
                schemaId: currentExamSchema.id,
                examKey: currentExamContext.key,
                examType: currentExamContext.key,
                examLabel: currentExamContext.label,
                studentId: studentId,
                classLabel: document.getElementById('entry-class-select').value,
                marks: marks,
                attendance: { workingDays: Number.isFinite(workingDays) ? workingDays : 0, presentDays: Number.isFinite(presentDays) ? presentDays : 0 },
                grades: summary.grades,
                totals: summary.totals,
                showMarksToStudents: true,
                published: effectivePublish === true,
                publishedAt: effectivePublish === true ? Date.now() : null,
                academicYear: currentAcademicYear,
                updatedAt: Date.now()
            };
            if (isTeacherCoreSubmit) {
                recordPayload.submittedToAdmin = true;
                recordPayload.submittedAt = Date.now();
            }
            batch.set(ref, recordPayload, {merge: true});
            operationCount++;
        }
    });

    if(operationCount === 0) return alert("No marks entered to save.");

    const draftBtn = document.getElementById('save-draft-btn');
    const publishBtn = document.getElementById('save-publish-btn');
    const activeBtn = shouldPublish ? publishBtn : draftBtn;
    activeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Saving...`;
    draftBtn.disabled = true;
    publishBtn.disabled = true;

    try {
        await batch.commit();
        if (isTeacherCoreSubmit) {
            activeBtn.innerHTML = `<i class="fas fa-check"></i> Submitted to Admin!`;
            notify(`Marks submitted to Admin for ${currentExamContext?.label || 'Core Exam'}. Admin will announce and publish via Publish Control.`);
        } else if (effectivePublish) {
            activeBtn.innerHTML = `<i class="fas fa-check"></i> Published!`;
            notify(`Results published successfully for ${selectedClass}!`);
        } else {
            activeBtn.innerHTML = `<i class="fas fa-check"></i> Draft Saved!`;
            notify('Draft marks saved successfully.');
        }
        setTimeout(() => {
            draftBtn.innerHTML = `<i class="fas fa-file"></i> Save as Draft`;
            updateMarkEntryActionButtonsUI();
            draftBtn.disabled = false;
            publishBtn.disabled = false;
        }, 2000);
    } catch (e) {
        console.error(e);
        alert("Failed to save marks. Check internet connection.");
        draftBtn.innerHTML = `<i class="fas fa-file"></i> Save as Draft`;
        updateMarkEntryActionButtonsUI();
        draftBtn.disabled = false;
        publishBtn.disabled = false;
    }
};
document.getElementById('save-draft-btn')?.addEventListener('click', async () => saveMarksFromEntry(false));
document.getElementById('save-publish-btn')?.addEventListener('click', async () => saveMarksFromEntry(true));

// --- Publish Logic & History Management ---
const startEditingPublishRecord = (recordId) => {
    const records = getPublishHistoryRecords();
    const record = records.find((r) => r.id === recordId);
    if (!record) return;

    editingPublishRecordId = record.id;
    const yearSelect = document.getElementById('publish-academic-year');
    if (yearSelect && record.academicYear) {
        yearSelect.value = record.academicYear;
        renderPublishControls();
    }
    const examSelect = document.getElementById('publish-exam-select');
    if (examSelect && record.examKey) {
        examSelect.value = record.examKey;
    }
    const titleInput = document.getElementById('publish-title');
    if (titleInput) {
        titleInput.value = record.examLabel || '';
    }

    const isScheduled = record.publishType === 'scheduled';
    const radioNow = document.querySelector('input[name="publish-action"][value="publish_now"]');
    const radioSchedule = document.querySelector('input[name="publish-action"][value="auto_publish"]');
    if (isScheduled && radioSchedule) {
        radioSchedule.checked = true;
    } else if (radioNow) {
        radioNow.checked = true;
    }
    setPublishModeVisual(isScheduled ? 'auto_publish' : 'publish_now');

    const publishAtInput = document.getElementById('publish-at-input');
    if (publishAtInput && record.publishAt) {
        try {
            const dateObj = new Date(record.publishAt);
            if (!Number.isNaN(dateObj.getTime())) {
                const pad = (n) => String(n).padStart(2, '0');
                const localStr = `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}T${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
                publishAtInput.value = localStr;
            }
        } catch (_) {}
    }

    const blockedList = Array.isArray(record.blockedClasses) ? record.blockedClasses : [];
    document.querySelectorAll('.blocked-class-checkbox').forEach((cb) => {
        cb.checked = blockedList.includes(cb.value);
    });

    const labelSpan = document.getElementById('run-publish-btn-label');
    if (labelSpan) labelSpan.textContent = 'Update Record';
    const cancelBtn = document.getElementById('cancel-publish-edit-btn');
    if (cancelBtn) cancelBtn.classList.remove('hidden');

    updatePublishLiveStatus();
    document.getElementById('publish-control-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

const cancelEditingPublishRecord = () => {
    editingPublishRecordId = null;
    const labelSpan = document.getElementById('run-publish-btn-label');
    const isNow = document.querySelector('input[name="publish-action"]:checked')?.value === 'publish_now';
    if (labelSpan) labelSpan.textContent = isNow ? 'Publish Now' : 'Save Schedule';
    const cancelBtn = document.getElementById('cancel-publish-edit-btn');
    if (cancelBtn) cancelBtn.classList.add('hidden');
    renderBlockedClasses();
    updatePublishLiveStatus();
};

const publishPendingExamDrafts = async (recordId) => {
    if (roleScope !== 'admin') return alert('Only administrators can publish results.');
    const record = getPublishHistoryRecords().find((r) => r.id === recordId);
    if (!record) return alert('Publish record not found.');

    const blockedList = Array.isArray(record.blockedClasses) ? record.blockedClasses : [];
    const draftsToPublish = examResultsCache.filter((row) => {
        if (row.published === true) return false;
        const matchesYear = !row.academicYear || row.academicYear === record.academicYear;
        const matchesExam = resultMatchesExam(row, record.examKey);
        const isOpenClass = !blockedList.includes(row.classLabel);
        return matchesYear && matchesExam && isOpenClass;
    });

    if (!draftsToPublish.length) {
        return alert('No pending draft results found in open classes for this exam.');
    }

    const ok = await showAppConfirm({
        title: 'Publish Pending Draft Results',
        message: `Found ${draftsToPublish.length} pending draft result(s) in open classes for "${record.examLabel || record.examKey}" (${record.academicYear}).\n\nPublish them now so students can view their results immediately?`,
        confirmText: `Publish ${draftsToPublish.length} Results`,
        type: 'warning'
    });
    if (!ok) return;

    await withBusyButton(null, 'Publishing...', async () => {
        for (let i = 0; i < draftsToPublish.length; i += 400) {
            const chunk = draftsToPublish.slice(i, i + 400);
            const batch = writeBatch(db);
            chunk.forEach((row) => {
                batch.update(doc(db, `${BASE_PATH}/examResults`, row.id), {
                    published: true,
                    publishedAt: Date.now(),
                    updatedAt: Date.now()
                });
            });
            await batch.commit();
        }

        const history = Array.isArray(resultCenterSettings.publishHistory) ? [...resultCenterSettings.publishHistory] : [];
        const idx = history.findIndex((r) => r.id === recordId);
        if (idx >= 0) {
            history[idx] = {
                ...history[idx],
                status: 'Live',
                publishType: 'published',
                publishedAt: new Date().toISOString(),
                lastSyncedAt: Date.now(),
                updatedAt: Date.now()
            };
            await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), {
                publishHistory: history,
                updatedAt: Date.now()
            }, { merge: true });
            resultCenterSettings.publishHistory = history;
        }

        renderPublishedHistoryTable();
        renderPublishedDraftTables();
        updateDashboard();
        showToast(`Published ${draftsToPublish.length} pending result(s) successfully!`, 'success');
    });
};

const unpublishExamResults = async (recordId) => {
    if (roleScope !== 'admin') return alert('Only admin can unpublish results.');
    const record = getPublishHistoryRecords().find((r) => r.id === recordId);
    if (!record) return alert('Publish record not found.');

    const ok = await showAppConfirm({
        title: 'Unpublish Examination Results',
        message: `Are you sure you want to unpublish results for "${record.examLabel || record.examKey}" (${record.academicYear})?\n\nThis will move all published marks back to Draft and hide them from students and report cards.`,
        confirmText: 'Revert to Draft',
        type: 'warning'
    });
    if (!ok) return;

    await withBusyButton(null, 'Unpublishing...', async () => {
        const rowsToUnpublish = examResultsCache.filter((row) => {
            if (row.published !== true) return false;
            const matchesYear = !row.academicYear || row.academicYear === record.academicYear;
            const matchesExam = resultMatchesExam(row, record.examKey);
            return matchesYear && matchesExam;
        });

        if (rowsToUnpublish.length > 0) {
            for (let i = 0; i < rowsToUnpublish.length; i += 400) {
                const chunk = rowsToUnpublish.slice(i, i + 400);
                const batch = writeBatch(db);
                chunk.forEach((row) => {
                    batch.update(doc(db, `${BASE_PATH}/examResults`, row.id), {
                        published: false,
                        publishedAt: null,
                        updatedAt: Date.now()
                    });
                });
                await batch.commit();
            }
        }

        let history = Array.isArray(resultCenterSettings.publishHistory) ? [...resultCenterSettings.publishHistory] : [];
        const recordIdx = history.findIndex((r) => r.id === recordId);
        if (recordIdx >= 0) {
            history[recordIdx] = {
                ...history[recordIdx],
                publishType: 'unpublished',
                status: 'Unpublished',
                unpublishedAt: Date.now(),
                updatedAt: Date.now()
            };
        }

        const isCurrentActiveAnnouncement = (resultCenterSettings.publishExamKey === record.examKey && (!resultCenterSettings.publishAcademicYear || resultCenterSettings.publishAcademicYear === record.academicYear));
        const settingsUpdate = {
            publishHistory: history,
            updatedAt: Date.now()
        };
        if (isCurrentActiveAnnouncement) {
            settingsUpdate.publishAt = '';
            settingsUpdate.examLabel = '';
            settingsUpdate.countdownStartedAt = '';
            resultCenterSettings.publishAt = '';
            resultCenterSettings.examLabel = '';
        }

        await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), settingsUpdate, { merge: true });

        resultCenterSettings.publishHistory = history;
        if (editingPublishRecordId === recordId) {
            cancelEditingPublishRecord();
        }

        renderPublishedHistoryTable();
        renderPublishedDraftTables();
        updateDashboard();
        notify(`Unpublished ${rowsToUnpublish.length} result(s) successfully! They are now in Draft.`);
    });
};

const deletePublishRecord = async (recordId) => {
    if (roleScope !== 'admin') return alert('Only admin can delete published records.');
    const record = getPublishHistoryRecords().find((r) => r.id === recordId);
    if (!record) return;

    const ok = await showAppConfirm({
        title: 'Remove Publish Record',
        message: `Remove "${record.examLabel || record.examKey}" from publish history?\n\nThis will also unpublish its results and revert them back to Draft.`,
        confirmText: 'Remove & Revert',
        type: 'danger'
    });
    if (!ok) return;

    const rowsToUnpublish = examResultsCache.filter((row) => {
        if (row.published !== true) return false;
        const matchesYear = !row.academicYear || row.academicYear === record.academicYear;
        const matchesExam = resultMatchesExam(row, record.examKey);
        return matchesYear && matchesExam;
    });

    if (rowsToUnpublish.length > 0) {
        for (let i = 0; i < rowsToUnpublish.length; i += 400) {
            const chunk = rowsToUnpublish.slice(i, i + 400);
            const batch = writeBatch(db);
            chunk.forEach((row) => {
                batch.update(doc(db, `${BASE_PATH}/examResults`, row.id), {
                    published: false,
                    publishedAt: null,
                    updatedAt: Date.now()
                });
            });
            await batch.commit();
        }
    }

    let history = Array.isArray(resultCenterSettings.publishHistory) ? [...resultCenterSettings.publishHistory] : [];
    history = history.filter((r) => r.id !== recordId);

    const isCurrentActiveAnnouncement = (resultCenterSettings.publishExamKey === record.examKey && (!resultCenterSettings.publishAcademicYear || resultCenterSettings.publishAcademicYear === record.academicYear));
    const settingsUpdate = {
        publishHistory: history,
        updatedAt: Date.now()
    };
    if (isCurrentActiveAnnouncement) {
        settingsUpdate.publishAt = '';
        settingsUpdate.examLabel = '';
        settingsUpdate.countdownStartedAt = '';
        resultCenterSettings.publishAt = '';
        resultCenterSettings.examLabel = '';
    }

    await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), settingsUpdate, { merge: true });

    resultCenterSettings.publishHistory = history;
    if (editingPublishRecordId === recordId) {
        cancelEditingPublishRecord();
    }
    renderPublishedHistoryTable();
    renderPublishedDraftTables();
    updateDashboard();
    notify('Published record removed and results returned to Draft.');
};

const runPublishAction = async () => {
    if (roleScope !== 'admin') return alert('Only admin can publish results.');
    const selectedAction = document.querySelector('input[name="publish-action"]:checked')?.value || 'publish_now';
    const title = document.getElementById('publish-title')?.value.trim();
    const publishAcademicYear = document.getElementById('publish-academic-year')?.value || currentAcademicYear;
    const publishExamKey = document.getElementById('publish-exam-select')?.value || '';

    if (!publishAcademicYear) return alert('Please select an Academic Year.');
    if (!publishExamKey) return alert('Please select an Exam.');
    if (!title) return alert('Please enter the Exam Name (Display).');

    const blocked = Array.from(document.querySelectorAll('.blocked-class-checkbox:checked')).map((el) => el.value);
    const isNow = selectedAction === 'publish_now';
    let publishAt = '';

    if (isNow) {
        publishAt = new Date().toISOString();
    } else {
        publishAt = document.getElementById('publish-at-input')?.value;
        if (!publishAt) return alert('Please set the Scheduled Date & Time.');
        const targetTs = new Date(publishAt).getTime();
        if (Number.isNaN(targetTs)) return alert('Invalid scheduled date/time.');
    }

    const existingRec = getPublishHistoryRecords().find((r) => r.academicYear === publishAcademicYear && r.examKey === publishExamKey);
    const isAlreadyLive = existingRec && (existingRec.publishType !== 'unpublished' && existingRec.status !== 'Unpublished');

    let actionPrompt = isNow
        ? `Are you sure you want to publish results now for ${title} (${publishAcademicYear})?\nResults will be viewable immediately by all classes except blocked: ${blocked.length ? blocked.join(', ') : 'None'}.`
        : `Are you sure you want to schedule results for ${title} on ${formatDateTimeLabel(publishAt)}?`;

    if (isAlreadyLive && !editingPublishRecordId) {
        actionPrompt = `Notice: "${title} (${publishAcademicYear})" is already published.\n\nDo you want to re-publish and update this record with current drafts and settings?`;
    }

    const ok = await showAppConfirm({
        title: isNow ? 'Publish Results Now' : 'Schedule Result Publishing',
        message: actionPrompt,
        confirmText: isNow ? 'Publish Now' : 'Save Schedule',
        type: 'warning'
    });
    if (!ok) return;

    await withBusyButton('run-publish-action-btn', isNow ? 'Publishing...' : 'Saving Schedule...', async () => {
        let history = Array.isArray(resultCenterSettings.publishHistory) ? [...resultCenterSettings.publishHistory] : [];
        let existingIdx = editingPublishRecordId
            ? history.findIndex((r) => r.id === editingPublishRecordId)
            : history.findIndex((r) => r.academicYear === publishAcademicYear && r.examKey === publishExamKey);

        const recordId = (existingIdx >= 0 && history[existingIdx].id) ? history[existingIdx].id : (editingPublishRecordId || `pub_${Date.now()}`);

        const newRecord = {
            id: recordId,
            academicYear: publishAcademicYear,
            examKey: publishExamKey,
            examLabel: title,
            publishType: isNow ? 'now' : 'scheduled',
            status: isNow ? 'Published' : 'Scheduled',
            publishAt,
            blockedClasses: blocked,
            createdAt: existingIdx >= 0 && history[existingIdx].createdAt ? history[existingIdx].createdAt : Date.now(),
            updatedAt: Date.now()
        };

        // Filter out any other duplicate history records of this same academic year and examKey
        history = history.filter((r) => !(r.id !== recordId && r.academicYear === publishAcademicYear && r.examKey === publishExamKey));

        const targetIndex = history.findIndex((r) => r.id === recordId);
        if (targetIndex >= 0) {
            history[targetIndex] = newRecord;
        } else {
            history.unshift(newRecord);
        }

        let publishedCount = 0;
        if (isNow) {
            const draftsToPublish = examResultsCache.filter((row) => {
                if (row.published === true) return false;
                const matchesYear = !row.academicYear || row.academicYear === publishAcademicYear;
                const matchesExam = resultMatchesExam(row, publishExamKey);
                const isBlocked = blocked.includes(row.classLabel);
                return matchesYear && matchesExam && !isBlocked;
            });
            publishedCount = draftsToPublish.length;
            if (draftsToPublish.length > 0) {
                for (let i = 0; i < draftsToPublish.length; i += 400) {
                    const chunk = draftsToPublish.slice(i, i + 400);
                    const batch = writeBatch(db);
                    chunk.forEach((row) => {
                        batch.update(doc(db, `${BASE_PATH}/examResults`, row.id), {
                            published: true,
                            publishedAt: Date.now(),
                            updatedAt: Date.now()
                        });
                    });
                    await batch.commit();
                }
            }
        }

        await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), {
            publishAt,
            examLabel: title,
            publishAcademicYear,
            publishExamKey,
            blockedClasses: blocked,
            publishHistory: history,
            locked: false,
            updatedAt: Date.now(),
            countdownStartedAt: isNow ? '' : ((publishAt && new Date(publishAt).getTime() > Date.now()) ? Date.now() : '')
        }, { merge: true });

        resultCenterSettings.publishHistory = history;
        resultCenterSettings.blockedClasses = blocked;
        resultCenterSettings.publishAt = publishAt;
        resultCenterSettings.examLabel = title;
        resultCenterSettings.publishAcademicYear = publishAcademicYear;
        resultCenterSettings.publishExamKey = publishExamKey;

        cancelEditingPublishRecord();
        renderPublishedHistoryTable();
        renderPublishedDraftTables();
        updateDashboard();
        alert(isNow ? (publishedCount > 0 ? `Results Published Successfully! (${publishedCount} row(s) published)` : 'Results Published! (All matching rows are now live)') : 'Auto publish schedule saved successfully!');
    });
};

document.getElementById('run-publish-action-btn')?.addEventListener('click', runPublishAction);
document.getElementById('cancel-publish-edit-btn')?.addEventListener('click', cancelEditingPublishRecord);

// Mode cards toggling
document.querySelectorAll('input[name="publish-action"]').forEach((radio) => {
    radio.addEventListener('change', () => setPublishModeVisual(radio.value));
});
document.getElementById('mode-card-now')?.addEventListener('click', () => {
    const radio = document.querySelector('input[name="publish-action"][value="publish_now"]');
    if (radio && !radio.checked) {
        radio.checked = true;
        setPublishModeVisual('publish_now');
    }
});
document.getElementById('mode-card-schedule')?.addEventListener('click', () => {
    const radio = document.querySelector('input[name="publish-action"][value="auto_publish"]');
    if (radio && !radio.checked) {
        radio.checked = true;
        setPublishModeVisual('auto_publish');
    }
});

// Block class selection helpers
document.getElementById('select-all-blocked-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.blocked-class-checkbox').forEach((cb) => { cb.checked = true; });
});
document.getElementById('clear-all-blocked-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.blocked-class-checkbox').forEach((cb) => { cb.checked = false; });
});

// Published History Table Event Delegation
document.getElementById('published-history-table-body')?.addEventListener('click', (e) => {
    const publishPendingBtn = e.target.closest('.publish-pending-record-btn');
    if (publishPendingBtn) {
        const id = publishPendingBtn.dataset.id;
        if (id) publishPendingExamDrafts(id);
        return;
    }
    const unpublishBtn = e.target.closest('.unpublish-record-btn');
    if (unpublishBtn) {
        const id = unpublishBtn.dataset.id;
        if (id) unpublishExamResults(id);
        return;
    }
    const editBtn = e.target.closest('.edit-publish-record-btn');
    if (editBtn) {
        const id = editBtn.dataset.id;
        if (id) startEditingPublishRecord(id);
        return;
    }
    const delBtn = e.target.closest('.delete-publish-record-btn');
    if (delBtn) {
        const id = delBtn.dataset.id;
        if (id) deletePublishRecord(id);
        return;
    }
});
document.getElementById('publish-history-year-filter')?.addEventListener('change', renderPublishedHistoryTable);

['publish-title', 'publish-at-input'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', updatePublishLiveStatus);
    document.getElementById(id)?.addEventListener('change', updatePublishLiveStatus);
});
document.getElementById('publish-academic-year')?.addEventListener('change', renderPublishControls);
const getSelectedSchemaForExamConfig = () => {
    const classLabel = document.getElementById('exam-config-class-select')?.value || '';
    return classLabel ? getSchemaForClass(currentAcademicYear, classLabel) : null;
};
const buildExamConfigRowHtml = (row = {}, subjectRows = []) => {
    const selected = new Set((row.subjects || []).map((value) => String(value || '').toLowerCase()));
    const subjectChecks = subjectRows.length
        ? subjectRows.map((subject) => {
            const checked = selected.size === 0 || selected.has(subject.id.toLowerCase()) || selected.has(subject.name.toLowerCase());
            return `<label class="inline-flex items-center gap-1 mr-3 mb-2 text-xs font-semibold text-slate-600"><input type="checkbox" class="exam-subject-checkbox" value="${escapeHtml(subject.id)}" ${checked ? 'checked' : ''}>${escapeHtml(subject.name)}</label>`;
        }).join('')
        : '<span class="text-xs text-red-500">Save subjects first.</span>';
    return `
    <tr class="exam-config-row border-t" data-key="${escapeHtml(row.key || '')}">
        <td class="p-2"><input type="text" class="exam-config-name-input w-full p-2 border rounded" value="${escapeHtml(row.label || '')}" placeholder="Exam name"></td>
        <td class="p-2"><div class="exam-subject-checkboxes">${subjectChecks}</div></td>
        <td class="p-2"><button type="button" class="exam-config-remove-row text-red-600 font-bold">✕</button></td>
    </tr>`;
};
const renderExamConfigRowsForSelectedClass = () => {
    const body = document.getElementById('exam-config-rows-body');
    if (!body) return;
    const schema = getSelectedSchemaForExamConfig();
    const subjectRows = getSchemaSubjectRows(schema || {});
    if (!schema) {
        body.innerHTML = `<tr><td colspan="3" class="p-3 text-sm text-gray-500 text-center">Select a class with saved subjects.</td></tr>`;
        return;
    }
    const rows = Object.entries(getCustomExamConfigs(schema.examConfigs || {}))
        .map(([key, config]) => ({ key, label: config?.label || DEFAULT_EXAM_DEFS.find((exam) => exam.key === key)?.label || key, subjects: config?.subjects || [] }));
    body.innerHTML = (rows.length ? rows : [{ key: '', label: '', subjects: subjectRows.map((subject) => subject.id) }])
        .map((row) => buildExamConfigRowHtml(row, subjectRows)).join('');
};
const setSetupMode = (mode = 'subjects') => {
    document.getElementById('subject-setup-panel')?.classList.toggle('hidden', mode !== 'subjects');
    document.getElementById('exam-setup-panel')?.classList.toggle('hidden', mode !== 'exams');

    const tabSubjects = document.getElementById('mode-tab-subjects');
    const tabExams = document.getElementById('mode-tab-exams');
    if (tabSubjects && tabExams) {
        if (mode === 'subjects') {
            tabSubjects.className = 'setup-mode-tab flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold cursor-pointer transition select-none bg-white text-indigo-700 shadow-xs';
            tabExams.className = 'setup-mode-tab flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold cursor-pointer transition select-none text-slate-600 hover:text-slate-900';
        } else {
            tabExams.className = 'setup-mode-tab flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold cursor-pointer transition select-none bg-white text-indigo-700 shadow-xs';
            tabSubjects.className = 'setup-mode-tab flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold cursor-pointer transition select-none text-slate-600 hover:text-slate-900';
        }
    }
};
const renderSubjectRowsEditor = (rows = []) => {
    const body = document.getElementById('subject-rows-body');
    if (!body) return;
    const safeRows = rows.length ? rows : [{ name: '', maxMarks: 100, passMarks: 35 }];
    body.innerHTML = safeRows.map((row) => buildSubjectRowHtml(row)).join('');
};
document.getElementById('subject-class-select')?.addEventListener('change', () => {
    const cls = document.getElementById('subject-class-select').value;
    const schema = resultSchemas.find((entry) => entry.classLabel === cls && (entry.academicYear === currentAcademicYear || !entry.academicYear));
    renderSubjectRowsEditor(getSchemaSubjectRows(schema || {}));
});
document.getElementById('subject-add-row-btn')?.addEventListener('click', () => {
    const body = document.getElementById('subject-rows-body');
    if (!body) return;
    body.insertAdjacentHTML('beforeend', buildSubjectRowHtml({ name: '', maxMarks: 100, passMarks: 35 }));
});
document.getElementById('subject-rows-body')?.addEventListener('click', (event) => {
    const btn = event.target.closest('.subject-remove-row');
    if (!btn) return;
    btn.closest('tr')?.remove();
});
document.getElementById('save-subject-schema-btn')?.addEventListener('click', async () => {
    if (!hasResultAccess) return alert('You do not have access to save schema.');
    const classLabel = document.getElementById('subject-class-select').value;
    if (!classLabel) return alert('Select class.');
    const isTeacherScope = (roleScope === 'staff' && teacherAssignedClasses.length > 0);
    if (isTeacherScope && !teacherAssignedClasses.includes(classLabel)) {
        return alert('You can only configure subjects for your assigned class (' + teacherAssignedClasses.join(', ') + ').');
    }
    if (!currentAcademicYear) return alert('Set the current academic year first.');
    const subjectRows = Array.from(document.querySelectorAll('#subject-rows-body .subject-row')).map((rowEl, index) => {
        const name = rowEl.querySelector('.subject-name-input')?.value?.trim() || '';
        const total = Number(rowEl.querySelector('.subject-total-input')?.value || 100);
        const pass = Number(rowEl.querySelector('.subject-pass-input')?.value || 35);
        return normalizeSubjectRow({ name, maxMarks: total, passMarks: pass }, index);
    }).filter(Boolean);
    const subjects = subjectRows.map((subject) => subject.name);
    if (!subjects.length) return alert('Enter subjects.');
    if (subjectRows.some((subject) => subject.passMarks > subject.maxMarks)) return alert('Pass mark cannot be greater than total mark.');
    const existingSchema = getSchemaForClass(currentAcademicYear, classLabel) || {};
    const docId = `${currentAcademicYear}_${classLabel}`.replace(/[^\w-]/g, '_');
    await withBusyButton('save-subject-schema-btn', 'Saving...', async () => {
        await setDoc(doc(db, `${BASE_PATH}/resultSchemas`, docId), {
            classLabel,
            academicYear: currentAcademicYear || '',
            subjects,
            subjectRows,
            examConfigs: getCustomExamConfigs(existingSchema.examConfigs || {}),
            updatedAt: Date.now()
        }, { merge: true });
    });
    alert('Subjects saved for this academic year.');
});
document.querySelectorAll('.setup-mode-radio').forEach((radio) => {
    radio.addEventListener('change', () => setSetupMode(radio.value));
});
document.getElementById('exam-config-class-select')?.addEventListener('change', renderExamConfigRowsForSelectedClass);
document.getElementById('exam-config-add-row-btn')?.addEventListener('click', () => {
    const body = document.getElementById('exam-config-rows-body');
    if (!body) return;
    const schema = getSelectedSchemaForExamConfig();
    if (!schema) return alert('Select a class and save subjects first.');
    body.insertAdjacentHTML('beforeend', buildExamConfigRowHtml({ label: '', subjects: getSchemaSubjectRows(schema).map((subject) => subject.id) }, getSchemaSubjectRows(schema)));
});
document.getElementById('exam-config-rows-body')?.addEventListener('click', (event) => {
    const btn = event.target.closest('.exam-config-remove-row');
    if (!btn) return;
    btn.closest('tr')?.remove();
});
document.getElementById('save-exam-config-btn')?.addEventListener('click', async () => {
    if (!hasResultAccess) return alert('You do not have access to save exams.');
    const classLabel = document.getElementById('exam-config-class-select')?.value || '';
    if (!classLabel) return alert('Select class.');
    const isTeacherScope = (roleScope === 'staff' && teacherAssignedClasses.length > 0);
    if (isTeacherScope && !teacherAssignedClasses.includes(classLabel)) {
        return alert('You can only configure exams for your assigned class (' + teacherAssignedClasses.join(', ') + ').');
    }
    if (!currentAcademicYear) return alert('Set the current academic year first.');
    const schema = getSelectedSchemaForExamConfig();
    if (!schema) return alert('Save subjects for this class first.');
    const subjectRows = getSchemaSubjectRows(schema);
    if (!subjectRows.length) return alert('Save subjects for this class first.');
    const nextConfigs = {};
    const usedKeys = new Set();
    Array.from(document.querySelectorAll('#exam-config-rows-body .exam-config-row')).forEach((rowEl) => {
        const label = rowEl.querySelector('.exam-config-name-input')?.value?.trim() || '';
        if (!label) return;
        let key = rowEl.dataset.key || makeExamKey(label);
        if (usedKeys.has(key) || nextConfigs[key]) key = `${key}_${usedKeys.size + 1}`;
        usedKeys.add(key);
        const selectedSubjects = Array.from(rowEl.querySelectorAll('.exam-subject-checkbox:checked')).map((input) => input.value);
        nextConfigs[key] = {
            label,
            subjects: selectedSubjects.length ? selectedSubjects : subjectRows.map((subject) => subject.id),
            showMarksToStudents: true
        };
    });
    if (!Object.keys(nextConfigs).length) {
        const ok = await showAppConfirm({
            title: 'Save Default Terminal Exams Only',
            message: 'No additional custom exams entered. Would you like to save this class with only the 3 default terminal examinations (Quarterly, Half-Yearly, Annual)?',
            confirmText: 'Save Default Exams',
            type: 'info'
        });
        if (!ok) return;
    }
    const docId = `${currentAcademicYear}_${classLabel}`.replace(/[^\w-]/g, '_');
    await withBusyButton('save-exam-config-btn', 'Saving...', async () => {
        await setDoc(doc(db, `${BASE_PATH}/resultSchemas`, docId), {
            classLabel,
            academicYear: currentAcademicYear || '',
            subjects: schema.subjects || subjectRows.map((subject) => subject.name),
            subjectRows,
            examConfigs: nextConfigs,
            updatedAt: Date.now()
        }, { merge: true });
    });
    alert('Exams saved for this class.');
});
document.getElementById('schema-list-class-filter')?.addEventListener('change', renderExamSetup);

document.getElementById('exam-list-container')?.addEventListener('click', async (event) => {
    const toggle = event.target.closest('.schema-menu-toggle');
    if (toggle) {
        const id = toggle.dataset.id;
        const targetMenu = document.querySelector(`.schema-menu[data-id="${id}"]`);
        const shouldOpen = targetMenu?.classList.contains('hidden');
        document.querySelectorAll('.schema-menu').forEach((menu) => menu.classList.add('hidden'));
        if (shouldOpen) targetMenu?.classList.remove('hidden');
        return;
    }
    const customExamEditBtn = event.target.closest('.custom-exam-edit-btn');
    if (customExamEditBtn) {
        const schema = resultSchemas.find((entry) => entry.id === customExamEditBtn.dataset.schemaId);
        if (!schema) return;
        const isTeacherScope = (roleScope === 'staff' && teacherAssignedClasses.length > 0);
        if (isTeacherScope && !teacherAssignedClasses.includes(schema.classLabel)) {
            return alert('You can only edit custom exams for your assigned class.');
        }
        document.querySelector('.setup-mode-radio[value="exams"]')?.click();
        const classSelect = document.getElementById('exam-config-class-select');
        if (classSelect) classSelect.value = schema.classLabel || '';
        renderExamConfigRowsForSelectedClass();
        const row = Array.from(document.querySelectorAll('#exam-config-rows-body .exam-config-row')).find((entry) => entry.dataset.key === (customExamEditBtn.dataset.examKey || ''));
        row?.querySelector('.exam-config-name-input')?.focus();
        row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }
    const customExamDeleteBtn = event.target.closest('.custom-exam-delete-btn');
    if (customExamDeleteBtn) {
        const schema = resultSchemas.find((entry) => entry.id === customExamDeleteBtn.dataset.schemaId);
        const examKey = customExamDeleteBtn.dataset.examKey || '';
        if (!schema || !examKey) return;
        const isTeacherScope = (roleScope === 'staff' && teacherAssignedClasses.length > 0);
        if (isTeacherScope && !teacherAssignedClasses.includes(schema.classLabel)) {
            return alert('You can only delete custom exams for your assigned class.');
        }
        const examLabel = schema.examConfigs?.[examKey]?.label || examKey;
        const ok = await showAppConfirm({
            title: 'Delete Custom Exam',
            message: `Delete exam "${examLabel}" from ${schema.classLabel}?\n\nExisting marks for this exam will remain in Draft/Published lists until deleted separately.`,
            confirmText: 'Delete Exam',
            type: 'danger'
        });
        if (!ok) return;
        const nextConfigs = getCustomExamConfigs(schema.examConfigs || {});
        delete nextConfigs[examKey];
        await updateDoc(doc(db, `${BASE_PATH}/resultSchemas`, schema.id), { examConfigs: nextConfigs, updatedAt: Date.now() });
        renderExamConfigRowsForSelectedClass();
        showToast(`Exam "${examLabel}" deleted`, 'success');
        return;
    }
    const editBtn = event.target.closest('.schema-edit-btn');
    if (editBtn) {
        const schema = resultSchemas.find((entry) => entry.id === editBtn.dataset.id);
        if (!schema) return;
        const isTeacherScope = (roleScope === 'staff' && teacherAssignedClasses.length > 0);
        if (isTeacherScope && !teacherAssignedClasses.includes(schema.classLabel)) {
            return alert('You can only edit subjects for your assigned class.');
        }
        const classSelect = document.getElementById('subject-class-select');
        if (classSelect) classSelect.value = schema.classLabel || '';
        document.querySelector('.setup-mode-radio[value="subjects"]')?.click();
        renderSubjectRowsEditor(getSchemaSubjectRows(schema));
        document.getElementById('subject-setup-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }
    const configExamsBtn = event.target.closest('.schema-configure-exams-btn');
    if (configExamsBtn) {
        const schema = resultSchemas.find((entry) => entry.id === configExamsBtn.dataset.id);
        if (!schema) return;
        const isTeacherScope = (roleScope === 'staff' && teacherAssignedClasses.length > 0);
        if (isTeacherScope && !teacherAssignedClasses.includes(schema.classLabel)) {
            return alert('You can only configure exams for your assigned class.');
        }
        document.querySelector('.setup-mode-radio[value="exams"]')?.click();
        const classSelect = document.getElementById('exam-config-class-select');
        if (classSelect) {
            classSelect.value = schema.classLabel || '';
            renderExamConfigRowsForSelectedClass();
        }
        document.getElementById('exam-setup-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }
    const delBtn = event.target.closest('.schema-delete-btn');
    if (delBtn) {
        const schema = resultSchemas.find((entry) => entry.id === delBtn.dataset.id);
        const isTeacherScope = (roleScope === 'staff' && teacherAssignedClasses.length > 0);
        if (isTeacherScope && !teacherAssignedClasses.includes(schema?.classLabel)) {
            return alert('You can only delete schema for your assigned class.');
        }
        const label = schema ? schema.classLabel : 'this class';
        const ok = await showAppConfirm({
            title: 'Delete Class Schema',
            message: `Are you sure you want to delete subjects and custom exam schema for ${label}? All configured evaluation criteria for this class will be removed.`,
            confirmText: 'Delete Schema',
            type: 'danger'
        });
        if (!ok) return;
        await deleteDoc(doc(db, `${BASE_PATH}/resultSchemas`, delBtn.dataset.id));
        showToast(`Schema for ${label} deleted`, 'success');
    }
});

const closeCarryforwardModal = () => {
    const modal = document.getElementById('carryforward-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        modal.style.display = 'none';
    }
    document.body.classList.remove('modal-scroll-lock');
};

document.getElementById('open-carryforward-modal-btn')?.addEventListener('click', () => {
    if (roleScope !== 'admin') return alert('Only administrators can carry forward subject schemas.');
    const modal = document.getElementById('carryforward-modal');
    if (!modal) return;
    
    // Find previous academic year
    const currentStartYear = Number(String(currentAcademicYear || '').split('-')[0]);
    let prevYear = '';
    if (Number.isFinite(currentStartYear)) {
        prevYear = `${currentStartYear - 1}-${currentStartYear}`;
    }
    
    let previousSchemas = resultSchemas.filter((entry) => entry.academicYear === prevYear);
    if (!previousSchemas.length) {
        const otherYears = [...new Set(resultSchemas.map((s) => s.academicYear).filter((y) => y && y !== currentAcademicYear))].sort();
        if (otherYears.length) {
            prevYear = otherYears[otherYears.length - 1];
            previousSchemas = resultSchemas.filter((entry) => entry.academicYear === prevYear);
        }
    }

    const subtitle = document.getElementById('carryforward-modal-subtitle');
    if (subtitle) {
        subtitle.textContent = prevYear 
            ? `Copy subject configurations from previous year (${prevYear}) to current year (${currentAcademicYear})`
            : `No previous academic year schemas found.`;
    }

    const listContainer = document.getElementById('carryforward-modal-classes-list');
    const applyBtn = document.getElementById('carryforward-modal-apply-btn');
    if (listContainer) {
        if (!previousSchemas.length) {
            listContainer.innerHTML = `
                <div class="text-center py-6 text-slate-500 text-xs">
                    <i class="fas fa-exclamation-triangle text-amber-500 text-xl mb-1.5 block"></i>
                    No saved subject configurations found for previous year (${prevYear || 'N/A'}).
                </div>
            `;
            if (applyBtn) applyBtn.disabled = true;
        } else {
            if (applyBtn) applyBtn.disabled = false;
            listContainer.innerHTML = previousSchemas.map((schema) => {
                const subRows = getSchemaSubjectRows(schema);
                const subNames = subRows.map((s) => s.name).join(', ') || 'No subjects';
                return `
                <label class="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 bg-white hover:border-indigo-300 cursor-pointer transition">
                    <input type="checkbox" class="carryforward-class-checkbox mt-0.5 rounded text-indigo-600 focus:ring-indigo-500" value="${escapeHtml(schema.id)}" checked>
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center justify-between">
                            <span class="font-bold text-slate-800 text-xs sm:text-sm">${escapeHtml(schema.classLabel)}</span>
                            <span class="text-[10px] bg-indigo-50 text-indigo-700 font-bold px-2 py-0.5 rounded">${subRows.length} subjects</span>
                        </div>
                        <p class="text-[11px] text-slate-500 truncate mt-0.5">${escapeHtml(subNames)}</p>
                    </div>
                </label>
                `;
            }).join('');
        }
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.display = 'flex';
    document.body.classList.add('modal-scroll-lock');
});

document.getElementById('carryforward-modal-close-x')?.addEventListener('click', closeCarryforwardModal);
document.getElementById('carryforward-modal-cancel')?.addEventListener('click', closeCarryforwardModal);

document.getElementById('carryforward-select-all-btn')?.addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('.carryforward-class-checkbox');
    const allChecked = Array.from(checkboxes).every((cb) => cb.checked);
    checkboxes.forEach((cb) => cb.checked = !allChecked);
});

document.getElementById('carryforward-modal-apply-btn')?.addEventListener('click', async () => {
    if (roleScope !== 'admin') return alert('Only administrators can carry forward subject schemas.');
    const selectedIds = Array.from(document.querySelectorAll('.carryforward-class-checkbox:checked')).map((cb) => cb.value);
    if (!selectedIds.length) return alert('Please select at least one class to carry forward.');

    const selectedSchemas = resultSchemas.filter((s) => selectedIds.includes(s.id));
    if (!selectedSchemas.length) return alert('No schemas selected.');

    await withBusyButton('carryforward-modal-apply-btn', 'Applying...', async () => {
        await Promise.all(selectedSchemas.map((schema) => {
            const docId = `${currentAcademicYear}_${schema.classLabel}`.replace(/[^\w-]/g, '_');
            return setDoc(doc(db, `${BASE_PATH}/resultSchemas`, docId), {
                classLabel: schema.classLabel,
                academicYear: currentAcademicYear,
                subjects: schema.subjects || [],
                subjectRows: getSchemaSubjectRows(schema),
                examConfigs: schema.examConfigs || {},
                updatedAt: Date.now()
            }, { merge: true });
        }));
    });

    closeCarryforwardModal();
    alert(`Successfully carried forward subjects for ${selectedSchemas.length} class(es) to academic year ${currentAcademicYear}.`);

    if (selectedSchemas[0]) {
        const select = document.getElementById('subject-class-select');
        if (select) {
            select.value = selectedSchemas[0].classLabel;
            renderSubjectRowsEditor(getSchemaSubjectRows(selectedSchemas[0]));
        }
    }
});

// Grade Rules & Multi-Scale Event Listeners
document.getElementById('add-grade-rule-row-btn')?.addEventListener('click', () => {
    const container = document.getElementById('grade-rules-rows');
    if (!container) return;
    const index = document.querySelectorAll('.grade-rule-row').length;
    container.insertAdjacentHTML('beforeend', `
        <div class="grid grid-cols-12 gap-2 items-center grade-rule-row">
            <div class="col-span-4 sm:col-span-3">
                <input type="text" class="grade-grade w-full p-2 border rounded-lg text-sm font-bold bg-white text-slate-800" data-index="${index}" value="" placeholder="e.g. B+">
            </div>
            <div class="col-span-3 sm:col-span-4">
                <input type="number" step="0.01" class="grade-min w-full p-2 border rounded-lg text-sm bg-white text-slate-800" data-index="${index}" value="0" placeholder="Min Mark">
            </div>
            <div class="col-span-3 sm:col-span-4">
                <input type="number" step="0.01" class="grade-max w-full p-2 border rounded-lg text-sm bg-white text-slate-800" data-index="${index}" value="0" placeholder="Max Mark">
            </div>
            <div class="col-span-2 sm:col-span-1 text-center">
                <button type="button" class="remove-grade-rule-row text-red-500 hover:text-red-700 p-1.5 rounded transition" title="Delete rule row">
                    <i class="fas fa-trash-alt text-xs"></i>
                </button>
            </div>
        </div>
    `);
});

document.getElementById('grade-rules-rows')?.addEventListener('click', (event) => {
    const removeBtn = event.target.closest('.remove-grade-rule-row');
    if (removeBtn) {
        removeBtn.closest('.grade-rule-row')?.remove();
    }
});

document.getElementById('save-grade-rules-btn')?.addEventListener('click', async () => {
    if (!hasResultAccess) return alert('You do not have permission to configure grade rules.');
    const totalInput = document.getElementById('grade-scale-total-input');
    const total = Number(totalInput?.value || 100);
    if (!Number.isFinite(total) || total <= 0) return alert('Please enter a valid total mark greater than 0.');

    const rowElements = Array.from(document.querySelectorAll('.grade-rule-row'));
    const rules = rowElements.map((row) => {
        const grade = row.querySelector('.grade-grade')?.value?.trim() || '';
        const min = Number(row.querySelector('.grade-min')?.value || 0);
        const max = Number(row.querySelector('.grade-max')?.value || 0);
        return { grade, min, max };
    }).filter((r) => r.grade);

    if (!rules.length) return alert('Please add at least one grade rule before saving.');

    // Update in-memory settings
    if (!resultCenterSettings.gradeScales) resultCenterSettings.gradeScales = {};
    resultCenterSettings.gradeScales[total] = rules;
    resultCenterSettings.gradeRules = rules;
    resultCenterSettings.gradeScaleTotal = total;

    await withBusyButton('save-grade-rules-btn', 'Saving...', async () => {
        await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), {
            gradeScales: resultCenterSettings.gradeScales,
            gradeRules: rules,
            gradeScaleTotal: total
        }, { merge: true });
    });

    renderGradeRules(total);
    refreshSubjectTotalDropdowns(total);
    alert(`Grade scale for ${total} marks successfully saved.`);
});

document.getElementById('saved-grade-scales-container')?.addEventListener('click', (event) => {
    const editBtn = event.target.closest('.edit-saved-scale-btn');
    if (!editBtn) return;
    const total = Number(editBtn.dataset.total);
    renderGradeRules(total);
    const totalInput = document.getElementById('grade-scale-total-input');
    totalInput?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    totalInput?.focus();
});
document.getElementById('save-blocked-classes-btn')?.addEventListener('click', async () => {
    const blocked = Array.from(document.querySelectorAll('.blocked-class-checkbox:checked')).map((el) => el.value);
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), { blockedClasses: blocked }, { merge: true });
    alert('Blocked classes saved.');
});
// ==========================================
// --- Advanced Snapshot Export & Import Logic ---
// ==========================================

const getSnapshotScopeYears = () => {
    const set = new Set();
    if (currentAcademicYear) set.add(currentAcademicYear);
    (availableAcademicYears || []).forEach((y) => { if (y) set.add(String(y).trim()); });
    (examResultsCache || []).forEach((r) => { if (r.academicYear) set.add(String(r.academicYear).trim()); });
    (resultSchemas || []).forEach((s) => { if (s.academicYear) set.add(String(s.academicYear).trim()); });
    return Array.from(set).filter(Boolean).sort((a, b) => String(b).localeCompare(String(a), undefined, { numeric: true }));
};

const renderSnapshotPanelUI = () => {
    const yearSelect = document.getElementById('snapshot-academic-year-select');
    if (!yearSelect) return;
    const years = getSnapshotScopeYears();
    const currentSelected = yearSelect.value || currentAcademicYear || 'all';

    let optionsHtml = `<option value="all">All Academic Years (Full Archive)</option>`;
    years.forEach((yr) => {
        const isCur = (yr === currentAcademicYear) ? ' (Active)' : '';
        optionsHtml += `<option value="${escapeHtml(yr)}">Academic Year ${escapeHtml(yr)}${isCur}</option>`;
    });
    yearSelect.innerHTML = optionsHtml;
    if (Array.from(yearSelect.options).some((o) => o.value === currentSelected)) {
        yearSelect.value = currentSelected;
    } else {
        yearSelect.value = currentAcademicYear || 'all';
    }
    updateSnapshotScopeMetrics();
};

const updateSnapshotScopeMetrics = () => {
    const yearSelect = document.getElementById('snapshot-academic-year-select');
    const selectedYear = yearSelect?.value || 'all';

    const inScopeRows = (selectedYear === 'all')
        ? examResultsCache
        : examResultsCache.filter((r) => r.academicYear === selectedYear);

    const totalRecords = inScopeRows.length;
    const publishedCount = inScopeRows.filter((r) => r.published === true).length;
    const draftCount = inScopeRows.filter((r) => r.published !== true).length;
    const representedClasses = [...new Set(inScopeRows.map((r) => r.classLabel).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const inScopeSchemas = (selectedYear === 'all')
        ? resultSchemas
        : resultSchemas.filter((s) => !s.academicYear || s.academicYear === selectedYear);

    const totalEl = document.getElementById('snapshot-stat-total-records');
    const pubEl = document.getElementById('snapshot-stat-published');
    const draftEl = document.getElementById('snapshot-stat-draft');
    const classesEl = document.getElementById('snapshot-stat-classes');
    const schemasEl = document.getElementById('snapshot-stat-schemas');
    const recordsSub = document.getElementById('snapshot-stat-records-sub');

    if (totalEl) totalEl.textContent = totalRecords;
    if (pubEl) pubEl.textContent = publishedCount;
    if (draftEl) draftEl.textContent = draftCount;
    if (classesEl) classesEl.textContent = representedClasses.length;
    if (schemasEl) schemasEl.textContent = inScopeSchemas.length;
    if (recordsSub) recordsSub.textContent = (selectedYear === 'all') ? 'full archive' : `in ${selectedYear}`;

    // Populate class selector for single or batch class-wise export
    const classSelect = document.getElementById('snapshot-export-single-class-select');
    if (classSelect) {
        const currentClassVal = classSelect.value;
        const availableClassList = representedClasses.length ? representedClasses : classes;
        classSelect.innerHTML = `<option value="">-- All Classes (Batch Class-wise) --</option>` +
            availableClassList.map((cls) => `<option value="${escapeHtml(cls)}">Class: ${escapeHtml(cls)}</option>`).join('');
        if (Array.from(classSelect.options).some((o) => o.value === currentClassVal)) {
            classSelect.value = currentClassVal;
        }
    }
};

document.getElementById('snapshot-academic-year-select')?.addEventListener('change', () => {
    updateSnapshotScopeMetrics();
});

document.getElementById('refresh-snapshot-scope-btn')?.addEventListener('click', () => {
    renderSnapshotPanelUI();
});

// Full Snapshot Export
document.getElementById('export-snapshot-all-btn')?.addEventListener('click', () => {
    const yearSelect = document.getElementById('snapshot-academic-year-select');
    const selectedYear = yearSelect?.value || 'all';

    const includeResults = document.getElementById('snapshot-export-opt-results')?.checked !== false;
    const includeSchemas = document.getElementById('snapshot-export-opt-schemas')?.checked !== false;
    const includeGrades = document.getElementById('snapshot-export-opt-grades')?.checked !== false;
    const includeHistory = document.getElementById('snapshot-export-opt-history')?.checked !== false;
    const statusFilter = document.getElementById('snapshot-export-status-filter')?.value || 'all';

    let rowsToExport = (selectedYear === 'all')
        ? [...examResultsCache]
        : examResultsCache.filter((r) => r.academicYear === selectedYear);

    if (statusFilter === 'published') {
        rowsToExport = rowsToExport.filter((r) => r.published === true);
    } else if (statusFilter === 'draft') {
        rowsToExport = rowsToExport.filter((r) => r.published !== true);
    }

    const schemasToExport = (selectedYear === 'all')
        ? [...resultSchemas]
        : resultSchemas.filter((s) => !s.academicYear || s.academicYear === selectedYear);

    const rawHistory = getPublishHistoryRecords();
    const historyToExport = (selectedYear === 'all')
        ? rawHistory
        : rawHistory.filter((h) => !h.academicYear || h.academicYear === selectedYear);

    const payload = {
        exportFormat: 'student-result-snapshot',
        version: '2.0',
        exportedAt: new Date().toISOString(),
        academicYear: selectedYear,
        statusFilter,
        recordCounts: {
            results: includeResults ? rowsToExport.length : 0,
            schemas: includeSchemas ? schemasToExport.length : 0,
            publishedHistory: includeHistory ? historyToExport.length : 0
        },
        settings: (includeGrades || includeHistory) ? {
            examLabel: resultCenterSettings.examLabel || '',
            publishAt: resultCenterSettings.publishAt || '',
            blockedClasses: resultCenterSettings.blockedClasses || [],
            gradeScales: includeGrades ? (resultCenterSettings.gradeScales || DEFAULT_GRADE_SCALES) : undefined,
            publishedHistory: includeHistory ? historyToExport : undefined
        } : undefined,
        schemas: includeSchemas ? schemasToExport : [],
        results: includeResults ? rowsToExport : []
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const yearSlug = (selectedYear === 'all' ? 'all_years' : selectedYear).replace(/[^a-zA-Z0-9_-]/g, '_');
    const dateSlug = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `result_snapshot_${yearSlug}_${dateSlug}.json`;
    a.click();
    URL.revokeObjectURL(url);

    const feedbackEl = document.getElementById('snapshot-export-feedback');
    if (feedbackEl) {
        feedbackEl.textContent = `✓ Exported ${includeResults ? rowsToExport.length : 0} exam results and ${includeSchemas ? schemasToExport.length : 0} schemas.`;
        feedbackEl.classList.remove('hidden');
        setTimeout(() => feedbackEl.classList.add('hidden'), 4000);
    }
});

// Class-wise Snapshot Export
document.getElementById('export-snapshot-classwise-btn')?.addEventListener('click', () => {
    const yearSelect = document.getElementById('snapshot-academic-year-select');
    const selectedYear = yearSelect?.value || 'all';
    const statusFilter = document.getElementById('snapshot-export-status-filter')?.value || 'all';
    const selectedClass = document.getElementById('snapshot-export-single-class-select')?.value || '';

    let rowsToExport = (selectedYear === 'all')
        ? [...examResultsCache]
        : examResultsCache.filter((r) => r.academicYear === selectedYear);

    if (statusFilter === 'published') {
        rowsToExport = rowsToExport.filter((r) => r.published === true);
    } else if (statusFilter === 'draft') {
        rowsToExport = rowsToExport.filter((r) => r.published !== true);
    }

    if (selectedClass) {
        const classRows = rowsToExport.filter((r) => r.classLabel === selectedClass);
        if (!classRows.length) {
            return alert(`No results found for Class "${selectedClass}" in selected scope.`);
        }
        const payload = {
            exportFormat: 'student-result-snapshot-class',
            version: '2.0',
            exportedAt: new Date().toISOString(),
            academicYear: selectedYear,
            classLabel: selectedClass,
            resultsCount: classRows.length,
            schemas: resultSchemas.filter((s) => s.classLabel === selectedClass),
            results: classRows
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const clsSlug = selectedClass.replace(/[^a-zA-Z0-9_-]/g, '_');
        a.href = url;
        a.download = `result_snapshot_${clsSlug}_${selectedYear === 'all' ? 'all' : selectedYear}.json`;
        a.click();
        URL.revokeObjectURL(url);
        return;
    }

    // Export all classes batch
    const classMap = {};
    rowsToExport.forEach((row) => {
        const cls = row.classLabel || 'unknown';
        if (!classMap[cls]) classMap[cls] = [];
        classMap[cls].push(row);
    });

    const entries = Object.entries(classMap);
    if (!entries.length) {
        return alert('No exam results found to export for selected scope.');
    }

    entries.forEach(([cls, items], idx) => {
        setTimeout(() => {
            const payload = {
                exportFormat: 'student-result-snapshot-class',
                version: '2.0',
                exportedAt: new Date().toISOString(),
                academicYear: selectedYear,
                classLabel: cls,
                resultsCount: items.length,
                schemas: resultSchemas.filter((s) => s.classLabel === cls),
                results: items
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `result_snapshot_${cls.replace(/[^a-zA-Z0-9_-]/g, '_')}_${selectedYear === 'all' ? 'all' : selectedYear}.json`;
            a.click();
            URL.revokeObjectURL(url);
        }, idx * 180);
    });
});

// Staged import data holder
let stagedSnapshotData = null;

const handleSnapshotFileSelection = (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
        return alert('Please select a valid .json snapshot file.');
    }
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const json = JSON.parse(e.target.result);
            let results = [];
            let schemas = [];
            let settings = {};
            let sourceYear = '';

            if (Array.isArray(json)) {
                results = json;
            } else if (typeof json === 'object' && json !== null) {
                results = Array.isArray(json.results) ? json.results : [];
                schemas = Array.isArray(json.schemas) ? json.schemas : [];
                settings = json.settings || {};
                sourceYear = json.academicYear || results[0]?.academicYear || schemas[0]?.academicYear || '';
            }

            if (!results.length && !schemas.length && !Object.keys(settings).length) {
                return alert('Invalid Snapshot File: Could not find any exam results, schemas, or settings in this JSON file.');
            }

            stagedSnapshotData = {
                file,
                name: file.name,
                size: file.size,
                data: json,
                results,
                schemas,
                settings,
                sourceYear
            };

            // Populate preview card
            const previewCard = document.getElementById('snapshot-import-preview');
            const filenameEl = document.getElementById('snapshot-preview-filename');
            const filesizeEl = document.getElementById('snapshot-preview-filesize');
            const yearEl = document.getElementById('snapshot-preview-year');
            const resultsCountEl = document.getElementById('snapshot-preview-results-count');
            const schemasCountEl = document.getElementById('snapshot-preview-schemas-count');
            const startBtn = document.getElementById('start-snapshot-import-btn');

            if (filenameEl) filenameEl.textContent = file.name;
            if (filesizeEl) filesizeEl.textContent = `${(file.size / 1024).toFixed(1)} KB`;
            if (yearEl) yearEl.textContent = sourceYear || 'As in records';
            if (resultsCountEl) resultsCountEl.textContent = results.length;
            if (schemasCountEl) schemasCountEl.textContent = schemas.length;

            // Populate Target Academic Year selector in preview
            const targetYearSelect = document.getElementById('snapshot-import-target-year');
            if (targetYearSelect) {
                const years = getSnapshotScopeYears();
                let options = `<option value="__as_in_file__">Keep Original Year (${sourceYear || 'From File'})</option>`;
                years.forEach((yr) => {
                    options += `<option value="${escapeHtml(yr)}">Assign to ${escapeHtml(yr)}</option>`;
                });
                targetYearSelect.innerHTML = options;
                if (sourceYear && years.includes(sourceYear)) {
                    targetYearSelect.value = sourceYear;
                }
            }

            if (previewCard) previewCard.classList.remove('hidden');
            if (startBtn) startBtn.disabled = false;
        } catch (err) {
            alert('Failed to parse snapshot JSON file: ' + err.message);
        }
    };
    reader.readAsText(file);
};

// Drag and drop & File Picker listeners
const snapshotDropzone = document.getElementById('snapshot-dropzone');
const snapshotFileInput = document.getElementById('snapshot-import-file');

snapshotDropzone?.addEventListener('click', () => snapshotFileInput?.click());

snapshotFileInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleSnapshotFileSelection(file);
});

snapshotDropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    snapshotDropzone.classList.add('border-indigo-500', 'bg-indigo-100/50');
});

snapshotDropzone?.addEventListener('dragleave', () => {
    snapshotDropzone.classList.remove('border-indigo-500', 'bg-indigo-100/50');
});

snapshotDropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    snapshotDropzone.classList.remove('border-indigo-500', 'bg-indigo-100/50');
    const file = e.dataTransfer.files?.[0];
    if (file) handleSnapshotFileSelection(file);
});

document.getElementById('snapshot-clear-file-btn')?.addEventListener('click', () => {
    stagedSnapshotData = null;
    if (snapshotFileInput) snapshotFileInput.value = '';
    document.getElementById('snapshot-import-preview')?.classList.add('hidden');
    const startBtn = document.getElementById('start-snapshot-import-btn');
    if (startBtn) startBtn.disabled = true;
});

// Import execution
document.getElementById('start-snapshot-import-btn')?.addEventListener('click', async () => {
    if (!stagedSnapshotData) return alert('Please select a snapshot JSON file first.');
    if (roleScope !== 'admin' && !isCurrentAdmin) return alert('Only administrators have permission to restore or import snapshot data.');

    const targetYearChoice = document.getElementById('snapshot-import-target-year')?.value || '__as_in_file__';
    const importMode = document.querySelector('input[name="snapshot-import-mode"]:checked')?.value || 'merge';

    const resultsTotal = stagedSnapshotData.results.length;
    const schemasTotal = stagedSnapshotData.schemas.length;
    const targetYearLabel = targetYearChoice === '__as_in_file__' ? (stagedSnapshotData.sourceYear || 'from snapshot records') : targetYearChoice;

    const confirmMsg = `Are you sure you want to restore / import this snapshot?\n\n` +
        `• Results to import: ${resultsTotal}\n` +
        `• Schemas to import: ${schemasTotal}\n` +
        `• Target Academic Year: ${targetYearLabel}\n` +
        `• Conflict Mode: ${importMode === 'replace' ? 'CLEAN OVERWRITE (Deletes existing results for this year)' : 'MERGE & UPDATE'}\n\n` +
        `Proceed with database restore?`;

    const ok = await showAppConfirm({
        title: 'Restore / Import Snapshot',
        message: confirmMsg,
        confirmText: 'Restore Snapshot',
        type: importMode === 'replace' ? 'danger' : 'warning'
    });
    if (!ok) return;

    const progressContainer = document.getElementById('snapshot-import-progress-container');
    const progressBar = document.getElementById('snapshot-import-progress-bar');
    const progressPct = document.getElementById('snapshot-import-progress-pct');
    const progressLabel = document.getElementById('snapshot-import-progress-label');
    const progressLog = document.getElementById('snapshot-import-log');
    const startBtn = document.getElementById('start-snapshot-import-btn');

    if (progressContainer) progressContainer.classList.remove('hidden');
    if (startBtn) startBtn.disabled = true;

    const setProgress = (percent, label, log = '') => {
        if (progressBar) progressBar.style.width = `${percent}%`;
        if (progressPct) progressPct.textContent = `${percent}%`;
        if (progressLabel) progressLabel.textContent = label;
        if (progressLog) progressLog.textContent = log;
    };

    try {
        // If clean overwrite is chosen and target year is defined:
        if (importMode === 'replace') {
            setProgress(5, 'Preparing clean overwrite...', 'Locating existing records...');
            const yearToClear = (targetYearChoice !== '__as_in_file__') ? targetYearChoice : stagedSnapshotData.sourceYear;
            if (yearToClear) {
                const rowsToDelete = examResultsCache.filter((r) => r.academicYear === yearToClear);
                if (rowsToDelete.length > 0) {
                    for (let i = 0; i < rowsToDelete.length; i += 400) {
                        const chunk = rowsToDelete.slice(i, i + 400);
                        const delBatch = writeBatch(db);
                        chunk.forEach((row) => {
                            delBatch.delete(doc(db, `${BASE_PATH}/examResults`, row.id));
                        });
                        await delBatch.commit();
                        setProgress(15, 'Clearing previous records...', `Deleted ${Math.min(i + 400, rowsToDelete.length)} of ${rowsToDelete.length}`);
                    }
                }
            }
        }

        // Import exam results in chunks
        if (resultsTotal > 0) {
            for (let i = 0; i < resultsTotal; i += 400) {
                const chunk = stagedSnapshotData.results.slice(i, i + 400);
                const batch = writeBatch(db);
                chunk.forEach((row) => {
                    const cleanRow = { ...row };
                    if (targetYearChoice !== '__as_in_file__') {
                        cleanRow.academicYear = targetYearChoice;
                    }
                    cleanRow.updatedAt = Date.now();
                    cleanRow.importedAt = Date.now();

                    const fallbackId = `${cleanRow.studentId || cleanRow.admissionNo || 'res'}_${cleanRow.examKey || 'exam'}_${cleanRow.academicYear || 'year'}`.replace(/[\/\s#]/g, '_');
                    const docId = cleanRow.id || fallbackId;
                    delete cleanRow.id;
                    batch.set(doc(db, `${BASE_PATH}/examResults`, docId), cleanRow, { merge: true });
                });
                await batch.commit();
                const pct = Math.round(20 + ((i + chunk.length) / resultsTotal) * 65);
                setProgress(pct, `Importing results (${Math.min(i + 400, resultsTotal)}/${resultsTotal})...`, `Batch committed successfully`);
            }
        }

        // Import schemas if present
        if (schemasTotal > 0) {
            setProgress(88, 'Importing exam schemas...', `${schemasTotal} schema definitions`);
            for (let i = 0; i < schemasTotal; i += 400) {
                const chunk = stagedSnapshotData.schemas.slice(i, i + 400);
                const schemaBatch = writeBatch(db);
                chunk.forEach((schema) => {
                    const cleanSchema = { ...schema };
                    if (targetYearChoice !== '__as_in_file__') {
                        cleanSchema.academicYear = targetYearChoice;
                    }
                    cleanSchema.updatedAt = Date.now();
                    const sId = cleanSchema.id || `schema_${(cleanSchema.classLabel || 'class').replace(/[\/\s#]/g, '_')}_${cleanSchema.academicYear || 'year'}`;
                    delete cleanSchema.id;
                    schemaBatch.set(doc(db, `${BASE_PATH}/resultSchemas`, sId), cleanSchema, { merge: true });
                });
                await schemaBatch.commit();
            }
        }

        // Import gradeScales / settings if present in snapshot
        if (stagedSnapshotData.settings?.gradeScales) {
            setProgress(95, 'Updating grade rules & settings...', 'Merging grade scales');
            await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), {
                gradeScales: stagedSnapshotData.settings.gradeScales
            }, { merge: true });
        }

        setProgress(100, 'Import completed successfully!', `Restored ${resultsTotal} results and ${schemasTotal} schemas.`);
        alert(`Snapshot Import Successful!\n\n• ${resultsTotal} examination results synced\n• ${schemasTotal} exam schemas configured\n• Database updated.`);

        stagedSnapshotData = null;
        if (snapshotFileInput) snapshotFileInput.value = '';
        document.getElementById('snapshot-import-preview')?.classList.add('hidden');
        setTimeout(() => {
            if (progressContainer) progressContainer.classList.add('hidden');
        }, 3500);

        renderSnapshotPanelUI();
    } catch (err) {
        console.error('Import error:', err);
        alert('Snapshot import encountered an error: ' + err.message);
        setProgress(0, 'Import failed', err.message);
        if (startBtn) startBtn.disabled = false;
    }
});
document.getElementById('run-auto-promotion-btn')?.addEventListener('click', async () => {
    if (roleScope !== 'admin') return;
    const targetAcademicYear = document.getElementById('promotion-target-year')?.value || '';
    if (!targetAcademicYear) return alert('Select target academic year first.');
    const annualRows = examResultsCache.filter((row) => row.published === true && detectAnnualResultRow(row));
    if (!annualRows.length) return alert('No annual published results found for promotion.');

    // Collect class targets from the on-screen card selects
    const classTargetMap = {};
    document.querySelectorAll('.promotion-target-class-select').forEach((sel) => {
        const fromCls = String(sel.dataset.class || '').trim();
        const toCls = String(sel.value || '').trim();
        if (fromCls) classTargetMap[fromCls] = toCls;
    });

    const ok = await showAppConfirm({
        title: 'Run Automatic Student Promotion',
        message: `Annual published results found: ${annualRows.length}.\n\nRun automatic promotion into academic year ${targetAcademicYear}? Eligible passed students will advance to their next configured classes.`,
        confirmText: 'Run Promotion',
        type: 'info'
    });
    if (!ok) return;

    const updates = [];
    const promotionDecisions = [];
    annualRows.forEach((row) => {
        if (!isPassFromMarks(row)) return;
        const student = students.find((entry) => entry.id === row.studentId);
        if (!student) return;
        const fromClass = student.class || row.classLabel || '';
        const nextClass = classTargetMap[fromClass] !== undefined ? classTargetMap[fromClass] : getNextClassLabel(fromClass);
        if (!nextClass) return; // Discontinue / No promotion

        const isAlumniTarget = String(nextClass).trim().toLowerCase() === 'alumni';
        const studentPayload = isAlumniTarget ? {
            class: 'Alumni',
            status: 'alumni',
            isAlumni: true,
            graduatedYear: currentAcademicYear || student.academicYear || '',
            finalClass: fromClass,
            academicYear: targetAcademicYear,
            promotedFrom: fromClass,
            promotedAt: new Date().toISOString()
        } : {
            class: nextClass,
            status: 'active',
            isAlumni: false,
            academicYear: targetAcademicYear,
            promotedFrom: fromClass,
            promotedAt: new Date().toISOString()
        };

        updates.push(updateDoc(doc(db, `${BASE_PATH}/students`, student.id), studentPayload));
        promotionDecisions.push(setDoc(doc(collection(db, `${BASE_PATH}/promotionDecisions`)), {
            studentId: student.id,
            studentName: student.name || '',
            fromClass: fromClass,
            toClass: nextClass,
            basedOn: 'annual',
            basedOnResultId: row.id,
            academicYear: targetAcademicYear,
            createdAt: new Date().toISOString()
        }));
    });
    if (!updates.length) return alert('No eligible PASS students found for promotion with a target class selected.');
    await Promise.all([...updates, ...promotionDecisions]);

    // Save class progression map to settings for persistent memory
    if (Object.keys(classTargetMap).length > 0) {
        await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), { classProgressionMap: classTargetMap }, { merge: true });
    }

    alert(`Auto promotion successfully completed for ${updates.length} students to academic year ${targetAcademicYear}.`);
    renderPromotionCandidatesUI();
});
document.getElementById('preview-promotion-btn')?.addEventListener('click', () => {
    renderPromotionCandidatesUI();
});
document.getElementById('copy-prev-year-schema-btn')?.addEventListener('click', async () => {
    if (roleScope !== 'admin') return;
    const currentStartYear = Number(String(currentAcademicYear || '').split('-')[0]);
    if (!Number.isFinite(currentStartYear)) return alert('Current academic year invalid.');
    const previousYear = `${currentStartYear - 1}-${currentStartYear}`;
    const previousSchemas = resultSchemas.filter((entry) => entry.academicYear === previousYear);
    if (!previousSchemas.length) return alert('No previous year schema found.');
    await Promise.all(previousSchemas.map((schema) => {
        const docId = `${currentAcademicYear}_${schema.classLabel}`.replace(/[^\w-]/g, '_');
        return setDoc(doc(db, `${BASE_PATH}/resultSchemas`, docId), {
            ...schema,
            id: undefined,
            academicYear: currentAcademicYear,
            updatedAt: Date.now()
        }, { merge: true });
    }));
    alert(`Copied ${previousSchemas.length} schemas from ${previousYear}.`);
});
document.getElementById('open-schema-carryforward-btn')?.addEventListener('click', async () => {
    if (roleScope !== 'admin') return;
    const currentStartYear = Number(String(currentAcademicYear || '').split('-')[0]);
    if (!Number.isFinite(currentStartYear)) return alert('Current academic year invalid.');
    const previousYear = `${currentStartYear - 1}-${currentStartYear}`;
    const previousSchemas = resultSchemas.filter((entry) => entry.academicYear === previousYear);
    if (!previousSchemas.length) return alert('No previous year schema found.');
    const host = document.getElementById('schema-carryforward-list');
    if (!host) return;
    host.innerHTML = previousSchemas.map((schema) => `<label class="flex items-center gap-2 border rounded-lg p-2"><input type="checkbox" class="carry-schema-checkbox" value="${escapeHtml(schema.id)}" checked><span>${escapeHtml(schema.classLabel)} (${escapeHtml(previousYear)})</span></label>`).join('') + `<button id="save-carryforward-selection-btn" class="bg-indigo-100 text-indigo-700 py-2 px-3 rounded font-bold">Save Selected</button>`;
});
document.getElementById('schema-carryforward-list')?.addEventListener('click', async (event) => {
    const btn = event.target.closest('#save-carryforward-selection-btn');
    if (!btn) return;
    const currentStartYear = Number(String(currentAcademicYear || '').split('-')[0]);
    const previousYear = `${currentStartYear - 1}-${currentStartYear}`;
    const previousSchemas = resultSchemas.filter((entry) => entry.academicYear === previousYear);
    const ids = Array.from(document.querySelectorAll('.carry-schema-checkbox:checked')).map((el) => el.value);
    const selected = previousSchemas.filter((schema) => ids.includes(schema.id));
    if (!selected.length) return alert('Select at least one class.');
    await Promise.all(selected.map((schema) => {
        const docId = `${currentAcademicYear}_${schema.classLabel}`.replace(/[^\w-]/g, '_');
        return setDoc(doc(db, `${BASE_PATH}/resultSchemas`, docId), { ...schema, id: undefined, academicYear: currentAcademicYear, updatedAt: Date.now() }, { merge: true });
    }));
    alert(`Copied ${selected.length} schemas from ${previousYear}.`);
});

const getConfiguredGrade = (total = 0, maximum = 0) => {
    if (!maximum || Number(total || 0) === 0) return '-';
    const totalNum = Number(total || 0);
    const maxNum = Number(maximum || 100);

    const scales = getEffectiveGradeScales();
    
    // Check if there is an exact scale matching maxNum (e.g. 50 or 100 or custom)
    const exactScale = scales[maxNum];
    if (Array.isArray(exactScale) && exactScale.length) {
        const matched = exactScale.find((rule) => totalNum >= Number(rule.min || 0) && totalNum <= Number(rule.max || 0));
        if (matched?.grade) return matched.grade;
    }

    // Normalize to 100 scale
    const percentage = (totalNum / maxNum) * 100;
    const scale100 = scales[100] || DEFAULT_GRADE_SCALES[100];
    if (Array.isArray(scale100) && scale100.length) {
        const matched100 = scale100.find((rule) => percentage >= Number(rule.min || 0) && percentage <= Number(rule.max || 0));
        if (matched100?.grade) return matched100.grade;
    }

    if (percentage >= 90) return 'A+';
    if (percentage >= 80) return 'A';
    if (percentage >= 60) return 'B';
    if (percentage >= 35) return 'C';
    return 'FAIL';
};
const compareAdmissionNo = (a = {}, b = {}) => String(a.student.adm || a.student.admissionNo || a.student.uid || '').localeCompare(String(b.student.adm || b.student.admissionNo || b.student.uid || ''), undefined, { numeric: true, sensitivity: 'base' });
const genderRank = (student = {}) => {
    const gender = String(student.gender || '').trim().toLowerCase();
    if (gender.startsWith('m') || gender.includes('boy')) return 0;
    if (gender.startsWith('f') || gender.includes('girl')) return 1;
    return 2;
};
const genderRankReverse = (student = {}) => {
    const gender = String(student.gender || '').trim().toLowerCase();
    if (gender.startsWith('f') || gender.includes('girl')) return 0;
    if (gender.startsWith('m') || gender.includes('boy')) return 1;
    return 2;
};
const sortReportRows = (rows = [], order = 'rank') => {
    const alphaAsc = (a, b) => String(a.student.name || '').localeCompare(String(b.student.name || ''), undefined, { numeric: true, sensitivity: 'base' });
    const alphaDesc = (a, b) => String(b.student.name || '').localeCompare(String(a.student.name || ''), undefined, { numeric: true, sensitivity: 'base' });
    const admAsc = (a, b) => compareAdmissionNo(a, b) || alphaAsc(a, b);
    const admDesc = (a, b) => compareAdmissionNo(b, a) || alphaAsc(a, b);
    return [...rows].sort((a, b) => {
        if (order === 'gender') {
            const diff = genderRank(a.student) - genderRank(b.student);
            if (diff !== 0) return diff;
            return admAsc(a, b);
        }
        if (order === 'gender_girls') {
            const diff = genderRankReverse(a.student) - genderRankReverse(b.student);
            if (diff !== 0) return diff;
            return admAsc(a, b);
        }
        if (order === 'admission') return admAsc(a, b);
        if (order === 'admission_desc') return admDesc(a, b);
        if (order === 'alpha') return alphaAsc(a, b);
        if (order === 'alpha_desc') return alphaDesc(a, b);
        if (order === 'rank') {
            const obtA = Number(a.row?.totals?.obtained ?? a.totals?.obtained ?? 0);
            const obtB = Number(b.row?.totals?.obtained ?? b.totals?.obtained ?? 0);
            return (obtB - obtA) || admAsc(a, b);
        }
        return admAsc(a, b);
    });
};
const getAttendanceLabel = (row = {}) => {
    const attendance = row?.attendance || {};
    if (attendance.presentDays !== undefined || attendance.workingDays !== undefined) return `${attendance.presentDays ?? '-'}/${attendance.workingDays ?? '-'}`;
    return '-';
};
document.getElementById('generate-class-report-btn').addEventListener('click', () => {
    const examId = document.getElementById('report-exam-select').value;
    const className = document.getElementById('report-class-select').value;
    const reportYear = document.getElementById('report-academic-year')?.value?.trim() || currentAcademicYear || '';
    const reportOrder = document.getElementById('report-order-select')?.value || 'rank';
    
    if(!reportYear || !className || !examId) return alert('Select Academic Year, Class and Exam.');
    
    const examContext = getExamContext(examId, className, reportYear);
    const exam = examContext?.schema;
    const classStudents = students.filter(s => s.class === className && (!reportYear || s.academicYear === reportYear || !s.academicYear));
    
    if(!examContext || !exam || classStudents.length === 0) return alert('Invalid data or no students.');

    const reportSubjects = getSchemaSubjectRows(exam, examContext?.key || '');
    if (!reportSubjects.length) return alert('No subjects configured for this exam.');

    const resultRows = classStudents.map((student) => {
        const resultRecord = examResultsCache.find(r => resultMatchesExam(r, examId) && r.studentId === student.id && (!reportYear || r.academicYear === reportYear || !r.academicYear) && r.published === true);
        const marks = resultRecord ? (resultRecord.marks || {}) : {};
        let total = 0;
        let maximum = 0;
        let isFail = !resultRecord;
        const subjectValues = reportSubjects.map((sub) => {
            maximum += Number(sub.maxMarks || 0);
            const m = getResultMark(marks, sub);
            const upper = String(m || '').trim().toUpperCase();
            const num = Number(m);
            if (upper === 'P') return 'P';
            if (Number.isFinite(num)) {
                total += num;
                if (num < Number(sub.passMarks || 0)) isFail = true;
                return num;
            }
            isFail = true;
            return m || '-';
        });
        const passStatus = isFail ? 'FAIL' : 'PASS';
        const storedTotal = resultRecord?.totals?.obtained;
        const storedMax = resultRecord?.totals?.maximum;
        const finalTotal = Number.isFinite(Number(storedTotal)) ? Number(storedTotal) : total;
        const finalMax = Number.isFinite(Number(storedMax)) && Number(storedMax) > 0 ? Number(storedMax) : maximum;
        return {
            student,
            resultRecord,
            subjectValues,
            total: finalTotal,
            maximum: finalMax,
            passStatus,
            grade: getConfiguredGrade(finalTotal, finalMax),
            attendance: getAttendanceLabel(resultRecord)
        };
    });

    const rankable = [...resultRows].sort((a, b) => b.total - a.total || String(a.student.name || '').localeCompare(String(b.student.name || '')));
    let lastScore = null;
    let lastRank = 0;
    rankable.forEach((row, index) => {
        if (lastScore === null || row.total !== lastScore) lastRank = index + 1;
        row.rank = lastRank;
        lastScore = row.total;
    });
    const orderedRows = sortReportRows(resultRows, reportOrder);

    const { jsPDF } = window.jspdf;
    const docPdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageWidth = docPdf.internal.pageSize.getWidth();
    const instName = institutionConfig.appName || 'Institution Name';
    const instPlace = institutionConfig.place || '';
    const instReg = institutionConfig.regNo || '';
    const orderLabels = { rank: 'Rank Order', admission: 'Admission No Order', gender: 'Boys First, then Girls', alpha: 'Alphabetical Order' };

    docPdf.setFont('helvetica', 'bold');
    docPdf.setFontSize(15);
    docPdf.text(instName, pageWidth / 2, 12, { align: 'center' });
    docPdf.setFont('helvetica', 'normal');
    docPdf.setFontSize(9);
    const subTitle = [instPlace, instReg ? `Reg No: ${instReg}` : ''].filter(Boolean).join(' | ');
    if (subTitle) docPdf.text(subTitle, pageWidth / 2, 18, { align: 'center' });
    docPdf.setFont('helvetica', 'bold');
    docPdf.setFontSize(10);
    docPdf.text(`Class: ${className}`, 14, 27);
    docPdf.text(`Exam: ${examContext.label}`, 80, 27);
    docPdf.text(`Academic Year: ${reportYear}`, 150, 27);
    docPdf.text(`Order: ${orderLabels[reportOrder] || orderLabels.rank}`, 225, 27);

    const headers = ['No', 'Adm No', 'Student Name', ...reportSubjects.map((subject) => `${subject.name} (${subject.maxMarks})`), 'Total', 'Result', 'Attendance', 'Rank'];
    const resultColIndex = headers.indexOf('Result');
    const body = orderedRows.map((row, index) => [
        index + 1,
        row.student.adm || row.student.admissionNo || row.student.uid || '-',
        row.student.name || '-',
        ...row.subjectValues,
        `${row.total}/${row.maximum}`,
        row.passStatus,
        row.attendance,
        row.rank || '-'
    ]);

    docPdf.autoTable({
        startY: 34,
        head: [headers],
        body,
        styles: { fontSize: reportSubjects.length > 8 ? 6.5 : 7.5, cellPadding: 1.5, overflow: 'linebreak', valign: 'middle' },
        headStyles: { fillColor: [79, 70, 229], textColor: [255, 255, 255], fontStyle: 'bold' },
        columnStyles: { 0: { cellWidth: 9 }, 1: { cellWidth: 18 }, 2: { cellWidth: 38 } },
        didParseCell: (data) => {
            if (data.section !== 'body') return;
            const rowMeta = orderedRows[data.row.index];
            if (rowMeta?.passStatus === 'FAIL' && data.column.index === resultColIndex) {
                data.cell.styles.textColor = [220, 38, 38];
                data.cell.styles.fontStyle = 'bold';
            }
        },
        didDrawPage: () => {
            const pageCount = docPdf.internal.getNumberOfPages();
            docPdf.setFontSize(8);
            docPdf.setTextColor(120);
            docPdf.text(`Page ${pageCount}`, pageWidth - 20, docPdf.internal.pageSize.getHeight() - 8);
            docPdf.setTextColor(0);
        }
    });

    docPdf.save(`Results_${reportYear}_${className}_${examContext.label.replace(/\s+/g, '_')}_${reportOrder}.pdf`);
});

document.getElementById('generate-individual-cards-btn')?.addEventListener('click', () => {
    const examId = document.getElementById('report-exam-select').value;
    const className = document.getElementById('report-class-select').value;
    const reportYear = document.getElementById('report-academic-year')?.value?.trim() || currentAcademicYear || '';
    const reportOrder = document.getElementById('report-order-select')?.value || 'rank';
    
    if(!reportYear || !className || !examId) return alert('Select Academic Year, Class and Exam.');
    
    const examContext = getExamContext(examId, className, reportYear);
    const exam = examContext?.schema;
    const classStudents = students.filter(s => s.class === className && (!reportYear || s.academicYear === reportYear || !s.academicYear));
    
    if(!examContext || !exam || classStudents.length === 0) return alert('Invalid data or no students.');

    const reportSubjects = getSchemaSubjectRows(exam, examContext?.key || '');
    if (!reportSubjects.length) return alert('No subjects configured for this exam.');

    const resultRows = classStudents.map((student) => {
        const resultRecord = examResultsCache.find(r => resultMatchesExam(r, examId) && r.studentId === student.id && (!reportYear || r.academicYear === reportYear || !r.academicYear) && r.published === true);
        const marks = resultRecord ? (resultRecord.marks || {}) : {};
        let total = 0;
        let maximum = 0;
        let isFail = !resultRecord;
        const subjectValues = reportSubjects.map((sub) => {
            maximum += Number(sub.maxMarks || 0);
            const m = getResultMark(marks, sub);
            const upper = String(m || '').trim().toUpperCase();
            const num = Number(m);
            if (upper === 'P') return { sub, val: 'P', num: 0, pass: true };
            if (Number.isFinite(num)) {
                total += num;
                const passed = num >= Number(sub.passMarks || 0);
                if (!passed) isFail = true;
                return { sub, val: num, num, pass: passed };
            }
            isFail = true;
            return { sub, val: m || '-', num: 0, pass: false };
        });
        const passStatus = isFail ? 'FAIL' : 'PASS';
        const storedTotal = resultRecord?.totals?.obtained;
        const storedMax = resultRecord?.totals?.maximum;
        const finalTotal = Number.isFinite(Number(storedTotal)) ? Number(storedTotal) : total;
        const finalMax = Number.isFinite(Number(storedMax)) && Number(storedMax) > 0 ? Number(storedMax) : maximum;
        return {
            student,
            resultRecord,
            subjectValues,
            total: finalTotal,
            maximum: finalMax,
            passStatus,
            grade: getConfiguredGrade(finalTotal, finalMax),
            attendance: getAttendanceLabel(resultRecord)
        };
    });

    const rankable = [...resultRows].sort((a, b) => b.total - a.total || String(a.student.name || '').localeCompare(String(b.student.name || '')));
    let lastScore = null;
    let lastRank = 0;
    rankable.forEach((row, index) => {
        if (lastScore === null || row.total !== lastScore) lastRank = index + 1;
        row.rank = lastRank;
        lastScore = row.total;
    });
    const orderedRows = sortReportRows(resultRows, reportOrder);

    const { jsPDF } = window.jspdf;
    const docPdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = docPdf.internal.pageSize.getWidth();
    const pageHeight = docPdf.internal.pageSize.getHeight();
    const instName = institutionConfig.appName || 'Institution Name';
    const instPlace = institutionConfig.place || '';
    const instReg = institutionConfig.regNo || '';

    orderedRows.forEach((row, idx) => {
        if (idx > 0) docPdf.addPage();

        docPdf.setDrawColor(79, 70, 229);
        docPdf.setLineWidth(0.8);
        docPdf.rect(8, 8, pageWidth - 16, pageHeight - 16);
        docPdf.setDrawColor(224, 231, 255);
        docPdf.setLineWidth(0.3);
        docPdf.rect(10, 10, pageWidth - 20, pageHeight - 20);

        docPdf.setFont('helvetica', 'bold');
        docPdf.setFontSize(16);
        docPdf.setTextColor(30, 27, 75);
        docPdf.text(instName, pageWidth / 2, 20, { align: 'center' });

        docPdf.setFont('helvetica', 'normal');
        docPdf.setFontSize(9);
        docPdf.setTextColor(100);
        const subTitle = [instPlace, instReg ? `Reg No: ${instReg}` : ''].filter(Boolean).join(' | ');
        if (subTitle) docPdf.text(subTitle, pageWidth / 2, 26, { align: 'center' });

        docPdf.setFillColor(238, 242, 255);
        docPdf.roundedRect(pageWidth / 2 - 35, 30, 70, 7, 2, 2, 'F');
        docPdf.setFont('helvetica', 'bold');
        docPdf.setFontSize(10);
        docPdf.setTextColor(67, 56, 202);
        docPdf.text('STUDENT REPORT CARD', pageWidth / 2, 35, { align: 'center' });

        docPdf.setFillColor(248, 250, 252);
        docPdf.setDrawColor(226, 232, 240);
        docPdf.roundedRect(14, 41, pageWidth - 28, 28, 2, 2, 'FD');

        const admNo = row.student.adm || row.student.admissionNo || row.student.uid || '-';
        const stName = row.student.name || '-';

        docPdf.setFontSize(9);
        docPdf.setTextColor(71, 85, 105);
        docPdf.text('Student Name:', 18, 48);
        docPdf.setFont('helvetica', 'bold');
        docPdf.setTextColor(15, 23, 42);
        docPdf.text(stName, 44, 48);

        docPdf.setFont('helvetica', 'normal');
        docPdf.setTextColor(71, 85, 105);
        docPdf.text('Admission No:', 18, 56);
        docPdf.setFont('helvetica', 'bold');
        docPdf.setTextColor(15, 23, 42);
        docPdf.text(admNo, 44, 56);

        docPdf.setFont('helvetica', 'normal');
        docPdf.setTextColor(71, 85, 105);
        docPdf.text('Class:', 18, 64);
        docPdf.setFont('helvetica', 'bold');
        docPdf.setTextColor(15, 23, 42);
        docPdf.text(className, 44, 64);

        docPdf.setFont('helvetica', 'normal');
        docPdf.setTextColor(71, 85, 105);
        docPdf.text('Academic Year:', pageWidth / 2 + 10, 48);
        docPdf.setFont('helvetica', 'bold');
        docPdf.setTextColor(15, 23, 42);
        docPdf.text(reportYear, pageWidth / 2 + 37, 48);

        docPdf.setFont('helvetica', 'normal');
        docPdf.setTextColor(71, 85, 105);
        docPdf.text('Examination:', pageWidth / 2 + 10, 56);
        docPdf.setFont('helvetica', 'bold');
        docPdf.setTextColor(15, 23, 42);
        docPdf.text(examContext.label, pageWidth / 2 + 37, 56);

        docPdf.setFont('helvetica', 'normal');
        docPdf.setTextColor(71, 85, 105);
        docPdf.text('Class Rank:', pageWidth / 2 + 10, 64);
        docPdf.setFont('helvetica', 'bold');
        docPdf.setTextColor(67, 56, 202);
        docPdf.text(String(row.rank || '-'), pageWidth / 2 + 37, 64);

        const subHeaders = ['#', 'Subject', 'Max Marks', 'Pass Marks', 'Obtained Marks', 'Status'];
        const subBody = row.subjectValues.map((item, sIdx) => [
            sIdx + 1,
            item.sub.name,
            item.sub.maxMarks,
            item.sub.passMarks,
            item.val,
            item.val === 'P' ? 'PASS' : (item.val === 'A' || item.val === 'AB') ? 'ABSENT' : item.pass ? 'PASS' : 'FAIL'
        ]);

        docPdf.autoTable({
            startY: 74,
            margin: { left: 14, right: 14 },
            head: [subHeaders],
            body: subBody,
            styles: { fontSize: 8.5, cellPadding: 2.2, valign: 'middle' },
            headStyles: { fillColor: [79, 70, 229], textColor: [255, 255, 255], fontStyle: 'bold' },
            columnStyles: {
                0: { cellWidth: 10, halign: 'center' },
                1: { cellWidth: 55 },
                2: { cellWidth: 26, halign: 'center' },
                3: { cellWidth: 26, halign: 'center' },
                4: { cellWidth: 32, halign: 'center', fontStyle: 'bold' },
                5: { halign: 'center' }
            },
            didParseCell: (data) => {
                if (data.section === 'body' && data.column.index === 5) {
                    if (data.cell.raw === 'FAIL') {
                        data.cell.styles.textColor = [220, 38, 38];
                        data.cell.styles.fontStyle = 'bold';
                    } else if (data.cell.raw === 'PASS') {
                        data.cell.styles.textColor = [16, 149, 101];
                        data.cell.styles.fontStyle = 'bold';
                    } else if (data.cell.raw === 'ABSENT') {
                        data.cell.styles.textColor = [217, 119, 6];
                        data.cell.styles.fontStyle = 'bold';
                    }
                }
            }
        });

        const finalY = docPdf.lastAutoTable.finalY + 6;

        docPdf.setFillColor(248, 250, 252);
        docPdf.setDrawColor(226, 232, 240);
        docPdf.roundedRect(14, finalY, pageWidth - 28, 24, 2, 2, 'FD');

        const pct = row.maximum > 0 ? Math.round((row.total / row.maximum) * 100) : 0;

        docPdf.setFont('helvetica', 'normal');
        docPdf.setFontSize(8.5);
        docPdf.setTextColor(71, 85, 105);
        docPdf.text('Total Marks:', 18, finalY + 8);
        docPdf.setFont('helvetica', 'bold');
        docPdf.setTextColor(15, 23, 42);
        docPdf.text(`${row.total} / ${row.maximum}`, 42, finalY + 8);

        docPdf.setFont('helvetica', 'normal');
        docPdf.setTextColor(71, 85, 105);
        docPdf.text('Percentage:', 18, finalY + 16);
        docPdf.setFont('helvetica', 'bold');
        docPdf.setTextColor(15, 23, 42);
        docPdf.text(`${pct}%`, 42, finalY + 16);

        docPdf.setFont('helvetica', 'normal');
        docPdf.setTextColor(71, 85, 105);
        docPdf.text('Attendance:', pageWidth / 2 + 10, finalY + 8);
        docPdf.setFont('helvetica', 'bold');
        docPdf.setTextColor(15, 23, 42);
        docPdf.text(row.attendance || '-', pageWidth / 2 + 35, finalY + 8);

        docPdf.setFont('helvetica', 'normal');
        docPdf.setTextColor(71, 85, 105);
        docPdf.text('Final Result:', pageWidth / 2 + 10, finalY + 16);
        docPdf.setFont('helvetica', 'bold');
        if (row.passStatus === 'PASS') {
            docPdf.setTextColor(16, 149, 101);
            docPdf.text(`PASSED (Grade: ${row.grade})`, pageWidth / 2 + 35, finalY + 16);
        } else {
            docPdf.setTextColor(220, 38, 38);
            docPdf.text('FAILED', pageWidth / 2 + 35, finalY + 16);
        }

        const signY = pageHeight - 30;
        docPdf.setDrawColor(203, 213, 225);
        docPdf.setLineWidth(0.4);
        docPdf.line(20, signY, 65, signY);
        docPdf.line(pageWidth - 65, signY, pageWidth - 20, signY);

        docPdf.setFont('helvetica', 'normal');
        docPdf.setFontSize(8);
        docPdf.setTextColor(100);
        docPdf.text('Class Teacher', 42.5, signY + 5, { align: 'center' });
        docPdf.text('Head of Institution / Principal', pageWidth - 42.5, signY + 5, { align: 'center' });
    });

    docPdf.save(`Report_Cards_${reportYear}_${className}_${examContext.label.replace(/\s+/g, '_')}.pdf`);
});


['report-academic-year', 'report-class-select', 'report-exam-select', 'report-order-select'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => {
        if (id === 'report-academic-year' || id === 'report-class-select') renderExamSelectOptions(document.getElementById('report-exam-select'), document.getElementById('report-class-select')?.value || '', document.getElementById('report-academic-year')?.value || currentAcademicYear, '-- Choose Exam --', true);
        updateReportPreview();
    });
    document.getElementById(id)?.addEventListener('input', updateReportPreview);
});
let editingResultId = '';
const getSchemaForResultRow = (row = {}) => resultSchemas.find((schema) => schema.id === row.schemaId) || getSchemaForClass(row.academicYear || currentAcademicYear, row.classLabel || '');
const validateMarkValueForMax = (value = '', maxMarks = 0) => {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return true;
    if (raw === 'P' || raw === 'A' || raw === 'AB') return true;
    const asNum = Number(raw);
    return Number.isFinite(asNum) && asNum >= 0 && asNum <= Number(maxMarks || 0);
};
const openResultEditModal = (resultId = '') => {
    const row = examResultsCache.find((entry) => entry.id === resultId);
    if (!row) return alert('Result record not found.');
    if (roleScope === 'staff' && teacherAssignedClasses.length > 0 && !teacherAssignedClasses.includes(row.classLabel)) {
        return alert('You can only view or edit results for your assigned classes.');
    }
    const schema = getSchemaForResultRow(row);
    if (!schema) return alert('Schema not found for this result.');
    const subjects = getSchemaSubjectRows(schema, row.examKey || parseExamValue(row.examId || '').examKey);
    if (!subjects.length) return alert('No subjects found for this result.');
    editingResultId = resultId;
    const modal = document.getElementById('result-edit-modal');
    const fields = document.getElementById('result-edit-fields');
    document.getElementById('result-edit-error')?.classList.add('hidden');
    const summary = document.getElementById('result-edit-summary');
    if (summary) summary.textContent = `${getStudentNameById(row.studentId)} • ${getExamNameById(row.examId, row)} • ${row.classLabel || ''}`;
    if (fields) {
        fields.innerHTML = subjects.map((subject) => {
            const existing = row.marks?.[subject.id] ?? row.marks?.[subject.name] ?? '';
            const value = getStoredMarkValue(existing);
            return `<label class="grid grid-cols-1 md:grid-cols-[1fr_120px] gap-2 items-center border rounded-lg p-3 bg-slate-50">
                <span class="font-semibold text-sm text-slate-700">${escapeHtml(subject.name)} <span class="text-xs text-slate-400">(${subject.maxMarks}/${subject.passMarks})</span></span>
                <input type="text" class="result-edit-mark-input p-2 border rounded text-center" data-subject="${escapeHtml(subject.id)}" data-subject-name="${escapeHtml(subject.name)}" data-max="${subject.maxMarks}" data-pass="${subject.passMarks}" value="${escapeHtml(value)}" placeholder="Mark / P / A">
            </label>`;
        }).join('');
    }
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        modal.style.display = 'flex';
    }
    document.body.classList.add('modal-scroll-lock');
};
const closeResultEditModal = () => {
    editingResultId = '';
    const modal = document.getElementById('result-edit-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        modal.style.display = 'none';
    }
    document.body.classList.remove('modal-scroll-lock');
};
const saveResultEditModal = async () => {
    const row = examResultsCache.find((entry) => entry.id === editingResultId);
    if (!row) return;
    if (roleScope === 'staff' && teacherAssignedClasses.length > 0 && !teacherAssignedClasses.includes(row.classLabel)) {
        return alert('You can only save results for your assigned classes.');
    }
    const inputs = Array.from(document.querySelectorAll('#result-edit-fields .result-edit-mark-input'));
    const invalid = inputs.find((input) => !validateMarkValueForMax(input.value, input.dataset.max));
    const errorEl = document.getElementById('result-edit-error');
    if (invalid) {
        invalid.classList.add('input-error');
        if (errorEl) {
            errorEl.textContent = `Invalid mark for ${invalid.dataset.subjectName}. Use 0-${invalid.dataset.max}, P for pass, or A for absent.`;
            errorEl.classList.remove('hidden');
        }
        return;
    }
    const marks = {};
    inputs.forEach((input) => {
        const value = input.value.trim();
        if (!value) return;
        marks[input.dataset.subject] = { value, name: input.dataset.subjectName || input.dataset.subject, maxMarks: Number(input.dataset.max || 0), passMarks: Number(input.dataset.pass || 0) };
    });
    if (!Object.keys(marks).length) return alert('Enter at least one mark.');
    const schema = getSchemaForResultRow(row);
    const subjectRows = getSchemaSubjectRows(schema || {}, row.examKey || parseExamValue(row.examId || '').examKey);
    const summary = buildResultSummary(marks, subjectRows);
    await withBusyButton('result-edit-save', 'Saving...', async () => {
        await updateDoc(doc(db, `${BASE_PATH}/examResults`, editingResultId), { marks, grades: summary.grades, totals: summary.totals, updatedAt: Date.now() });
    });
    closeResultEditModal();
};
const handleResultRowAction = async (event, expectedPublished = false) => {
    const menuToggle = event.target.closest('.result-row-menu-toggle');
    if (menuToggle) {
        const id = menuToggle.dataset.id;
        const menu = document.querySelector(`.result-row-menu[data-id="${id}"]`);
        const shouldOpen = menu?.classList.contains('hidden');
        document.querySelectorAll('.result-row-menu').forEach((entry) => entry.classList.add('hidden'));
        if (shouldOpen) menu?.classList.remove('hidden');
        return;
    }
    const editBtn = event.target.closest('.edit-result-btn');
    if (editBtn) return openResultEditModal(editBtn.dataset.id);

    // Publishing and deleting results is restricted to admin
    if (roleScope !== 'admin') {
        alert('Only administrators have permission to publish or delete results.');
        return;
    }
    const targetBtn = event.target.closest('.publish-toggle-btn');
    const deleteBtn = event.target.closest('.delete-result-btn');
    if (targetBtn) {
        const publish = targetBtn.dataset.next === 'published';
        await updateDoc(doc(db, `${BASE_PATH}/examResults`, targetBtn.dataset.id), { published: publish, publishedAt: publish ? Date.now() : null, updatedAt: Date.now() });
    }
    if (deleteBtn) {
        const ok = await showAppConfirm({
            title: expectedPublished ? 'Delete Published Result' : 'Delete Draft Result',
            message: expectedPublished
                ? 'Are you sure you want to permanently delete this published result record?'
                : 'Are you sure you want to permanently delete this draft result record?',
            confirmText: 'Delete Record',
            type: 'danger'
        });
        if (ok) {
            await deleteDoc(doc(db, `${BASE_PATH}/examResults`, deleteBtn.dataset.id));
            showToast('Result deleted successfully', 'success');
        }
    }
};
document.getElementById('result-edit-cancel')?.addEventListener('click', closeResultEditModal);
document.getElementById('result-edit-save')?.addEventListener('click', saveResultEditModal);
document.getElementById('result-edit-fields')?.addEventListener('input', (event) => {
    const input = event.target.closest('.result-edit-mark-input');
    if (!input) return;
    input.classList.toggle('input-error', !validateMarkValueForMax(input.value, input.dataset.max));
});
document.getElementById('published-results-table')?.addEventListener('click', async (event) => handleResultRowAction(event, true));
document.getElementById('draft-results-table')?.addEventListener('click', async (event) => handleResultRowAction(event, false));
document.getElementById('published-class-filter')?.addEventListener('change', () => {
    const classValue = document.getElementById('published-class-filter')?.value || '';
    const examSelect = document.getElementById('published-exam-filter');
    renderExamSelectOptions(examSelect, classValue, currentAcademicYear, 'All Exams');
    if (examSelect) examSelect.value = '';
    renderPublishedDraftTables();
});
document.getElementById('draft-class-filter')?.addEventListener('change', () => {
    const classValue = document.getElementById('draft-class-filter')?.value || '';
    const examSelect = document.getElementById('draft-exam-filter');
    renderExamSelectOptions(examSelect, classValue, currentAcademicYear, 'All Exams');
    if (examSelect) examSelect.value = '';
    renderPublishedDraftTables();
});
document.getElementById('published-exam-filter')?.addEventListener('change', renderPublishedDraftTables);
document.getElementById('draft-exam-filter')?.addEventListener('change', renderPublishedDraftTables);
document.getElementById('published-order-filter')?.addEventListener('change', renderPublishedDraftTables);
document.getElementById('draft-order-filter')?.addEventListener('change', renderPublishedDraftTables);
document.getElementById('published-bulk-unpublish-btn')?.addEventListener('click', async () => {
    if (roleScope !== 'admin') return;
    const ids = Array.from(document.querySelectorAll('.published-select-checkbox:checked')).map((el) => el.value);
    if (!ids.length) return alert('Select at least one published result.');
    const ok = await showAppConfirm({
        title: 'Revert Results to Draft',
        message: `Move ${ids.length} selected published result(s) back to draft? They will no longer be visible on student portals.`,
        confirmText: 'Move to Draft',
        type: 'warning'
    });
    if (!ok) return;
    await withBusyButton('published-bulk-unpublish-btn', 'Moving to Draft...', async () => {
        await Promise.all(ids.map((id) => updateDoc(doc(db, `${BASE_PATH}/examResults`, id), { published: false, publishedAt: null, updatedAt: Date.now() })));
        notify(`Moved ${ids.length} result(s) back to draft.`);
    });
});
document.getElementById('published-bulk-delete-btn')?.addEventListener('click', async () => {
    if (roleScope !== 'admin') return;
    const ids = Array.from(document.querySelectorAll('.published-select-checkbox:checked')).map((el) => el.value);
    if (!ids.length) return alert('Select at least one result.');
    const ok = await showAppConfirm({
        title: 'Delete Published Results',
        message: `Permanently delete ${ids.length} selected published result(s)? This action cannot be reversed.`,
        confirmText: 'Delete Selected',
        type: 'danger'
    });
    if (!ok) return;
    await withBusyButton('published-bulk-delete-btn', 'Deleting...', async () => {
        await Promise.all(ids.map((id) => deleteDoc(doc(db, `${BASE_PATH}/examResults`, id))));
        notify(`Deleted ${ids.length} published result(s).`);
    });
});
document.getElementById('draft-bulk-publish-btn')?.addEventListener('click', async () => {
    if (roleScope !== 'admin') return;
    const ids = Array.from(document.querySelectorAll('.draft-select-checkbox:checked')).map((el) => el.value);
    if (!ids.length) return alert('Select at least one draft result.');
    await withBusyButton('draft-bulk-publish-btn', 'Publishing...', async () => {
        await Promise.all(ids.map((id) => updateDoc(doc(db, `${BASE_PATH}/examResults`, id), { published: true, publishedAt: Date.now(), updatedAt: Date.now() })));
        notify(`Published ${ids.length} draft result(s).`);
    });
});
document.getElementById('draft-bulk-delete-btn')?.addEventListener('click', async () => {
    if (roleScope !== 'admin') return;
    const ids = Array.from(document.querySelectorAll('.draft-select-checkbox:checked')).map((el) => el.value);
    if (!ids.length) return alert('Select at least one draft result.');
    const ok = await showAppConfirm({
        title: 'Delete Draft Results',
        message: `Permanently delete ${ids.length} selected draft result(s)?`,
        confirmText: 'Delete Selected',
        type: 'danger'
    });
    if (!ok) return;
    await withBusyButton('draft-bulk-delete-btn', 'Deleting...', async () => {
        await Promise.all(ids.map((id) => deleteDoc(doc(db, `${BASE_PATH}/examResults`, id))));
        notify(`Deleted ${ids.length} draft result(s).`);
    });
});


document.getElementById('save-promotion-map-btn')?.addEventListener('click', async () => {
    const map = {};
    Array.from(document.querySelectorAll('.promotion-map-input')).forEach((input) => {
        const fromClass = String(input.dataset.class || '').trim();
        const toClass = String(input.value || '').trim();
        if (fromClass && toClass) map[fromClass] = toClass;
    });
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), { classProgressionMap: map }, { merge: true });
    alert('Promotion mapping saved.');
});
document.getElementById('save-result-visibility-btn')?.addEventListener('click', async () => {
    if (roleScope !== 'admin') return;
    const map = {};
    document.querySelectorAll('.result-visibility-checkbox').forEach((el) => {
        const key = el.dataset.key;
        const type = el.dataset.type || 'marks';
        if (!map[key]) map[key] = { marks: true, grades: true };
        map[key][type] = el.checked;
    });
    await setDoc(doc(db, `${BASE_PATH}/settings`, 'resultCenter'), { resultVisibilityMap: map }, { merge: true });
    alert('Student result visibility settings saved.');
});
document.getElementById('result-visibility-grid')?.addEventListener('click', (event) => {
    const card = event.target.closest('.visibility-class-card');
    if (!card) return;
    const cls = card.dataset.class || '';
    const modal = document.getElementById('visibility-modal');
    const body = document.getElementById('visibility-modal-body');
    const title = document.getElementById('visibility-modal-title');
    if (!modal || !body || !title) return;
    const map = resultCenterSettings.resultVisibilityMap || {};
    title.textContent = `Visibility - ${cls}`;
    const schemas = resultSchemas.filter((schema) => schema.classLabel === cls && (schema.academicYear === currentAcademicYear || !schema.academicYear));
    const rows = schemas.flatMap((schema) => getExamOptionsForClass(schema.classLabel, currentAcademicYear).map((exam) => {
        const key = buildVisibilityKey(cls, exam.key);
        const visibility = map[key] && typeof map[key] === 'object' ? map[key] : { marks: map[key] !== false, grades: map[key] !== false };
        return `<div class="border rounded p-2"><div class="text-sm font-semibold">${escapeHtml(exam.label)}</div><div class="flex gap-4 text-sm mt-1"><label><input type="checkbox" class="result-visibility-checkbox" data-key="${escapeHtml(key)}" data-type="marks" ${visibility.marks ? 'checked' : ''}> Mark</label><label><input type="checkbox" class="result-visibility-checkbox" data-key="${escapeHtml(key)}" data-type="grades" ${visibility.grades ? 'checked' : ''}> Grade</label></div></div>`;
    }));
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.display = 'flex';
    document.body.classList.add('modal-scroll-lock');
});
document.getElementById('visibility-modal-close')?.addEventListener('click', () => {
    const modal = document.getElementById('visibility-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        modal.style.display = 'none';
    }
    document.body.classList.remove('modal-scroll-lock');
});
const bindSelectToggle = (btnId, checkboxClass) => {
    document.getElementById(btnId)?.addEventListener('click', () => {
        const btn = document.getElementById(btnId);
        const boxes = Array.from(document.querySelectorAll(`.${checkboxClass}`));
        const allChecked = boxes.length && boxes.every((box) => box.checked);
        boxes.forEach((box) => { box.checked = !allChecked; });
        if (btn) btn.textContent = allChecked ? 'Select All' : 'Deselect All';
    });
};
bindSelectToggle('published-select-toggle-btn', 'published-select-checkbox');
bindSelectToggle('draft-select-toggle-btn', 'draft-select-checkbox');

// Published smart filter buttons
document.querySelectorAll('.published-quick-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        currentPublishedFilter = btn.dataset.filter || 'all';
        document.querySelectorAll('.published-quick-filter-btn').forEach((b) => {
            b.classList.remove('active', 'bg-indigo-600', 'text-white', 'shadow-sm');
            if (b.dataset.filter === 'passed') {
                b.className = 'published-quick-filter-btn text-xs font-bold px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition';
            } else if (b.dataset.filter === 'failed') {
                b.className = 'published-quick-filter-btn text-xs font-bold px-3 py-1.5 rounded-lg bg-red-50 text-red-700 hover:bg-red-100 transition';
            } else if (b.dataset.filter === 'absent') {
                b.className = 'published-quick-filter-btn text-xs font-bold px-3 py-1.5 rounded-lg bg-amber-50 text-amber-800 hover:bg-amber-100 transition';
            } else if (b.dataset.filter === 'p_awarded') {
                b.className = 'published-quick-filter-btn text-xs font-bold px-3 py-1.5 rounded-lg bg-purple-50 text-purple-700 hover:bg-purple-100 transition';
            } else {
                b.className = 'published-quick-filter-btn text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 transition';
            }
        });
        btn.className = 'published-quick-filter-btn active text-xs font-bold px-3 py-1.5 rounded-lg bg-indigo-600 text-white shadow-sm transition';
        renderPublishedDraftTables();
    });
});

// Draft smart filter buttons & select-all in table header
document.querySelectorAll('.draft-quick-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        currentDraftFilter = btn.dataset.filter || 'all';
        document.querySelectorAll('.draft-quick-filter-btn').forEach((b) => {
            b.classList.remove('active', 'bg-indigo-600', 'text-white', 'shadow-sm');
            if (b.dataset.filter === 'passed') {
                b.className = 'draft-quick-filter-btn text-xs font-bold px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition';
            } else if (b.dataset.filter === 'failed') {
                b.className = 'draft-quick-filter-btn text-xs font-bold px-3 py-1.5 rounded-lg bg-red-50 text-red-700 hover:bg-red-100 transition';
            } else if (b.dataset.filter === 'absent') {
                b.className = 'draft-quick-filter-btn text-xs font-bold px-3 py-1.5 rounded-lg bg-amber-50 text-amber-800 hover:bg-amber-100 transition';
            } else if (b.dataset.filter === 'p_awarded') {
                b.className = 'draft-quick-filter-btn text-xs font-bold px-3 py-1.5 rounded-lg bg-purple-50 text-purple-700 hover:bg-purple-100 transition';
            } else {
                b.className = 'draft-quick-filter-btn text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 transition';
            }
        });
        btn.className = 'draft-quick-filter-btn active text-xs font-bold px-3 py-1.5 rounded-lg bg-indigo-600 text-white shadow-sm transition';
        renderPublishedDraftTables();
    });
});

document.addEventListener('change', (e) => {
    if (e.target.id === 'draft-table-select-all') {
        const isChecked = e.target.checked;
        document.querySelectorAll('.draft-select-checkbox').forEach((cb) => {
            cb.checked = isChecked;
        });
        const toggleBtn = document.getElementById('draft-select-toggle-btn');
        if (toggleBtn) toggleBtn.textContent = isChecked ? 'Deselect All' : 'Select All';
    } else if (e.target.id === 'published-table-select-all') {
        const isChecked = e.target.checked;
        document.querySelectorAll('.published-select-checkbox').forEach((cb) => {
            cb.checked = isChecked;
        });
        const toggleBtn = document.getElementById('published-select-toggle-btn');
        if (toggleBtn) toggleBtn.textContent = isChecked ? 'Deselect All' : 'Select All';
    }
});

// Marks Entry Sort, Grouping, Absent & Clear buttons
document.getElementById('entry-sort-order')?.addEventListener('change', () => loadMarksTable());
document.getElementById('entry-gender-order')?.addEventListener('change', () => loadMarksTable());

document.getElementById('mark-fill-absent-btn')?.addEventListener('click', () => {
    let count = 0;
    document.querySelectorAll('#marks-table-body .mark-input').forEach((input) => {
        if (!input.value.trim()) {
            input.value = 'A';
            count++;
        }
    });
    validateMarksTable();
    if (count > 0) {
        alert(`Filled ${count} empty mark(s) with 'A' (Absent).`);
    } else {
        alert("No empty mark inputs found.");
    }
});

document.getElementById('mark-clear-btn')?.addEventListener('click', async () => {
    const ok = await showAppConfirm({
        title: 'Clear Marks Table',
        message: 'Are you sure you want to clear all entered marks in this table? Any unsaved edits will be lost.',
        confirmText: 'Clear Marks',
        type: 'warning'
    });
    if (!ok) return;
    document.querySelectorAll('#marks-table-body .mark-input').forEach((input) => {
        input.value = '';
    });
    validateMarksTable();
    showToast('Marks table cleared', 'info');
});

document.getElementById('grade-scale-total-input')?.addEventListener('change', (e) => {
    const total = Number(e.target.value || 100);
    if (total > 0) renderGradeRules(total);
});

// Settings & Setup Sub-Panel Activator (hamburger menu & subtab buttons)
const activateSettingsSubpanel = (subtabId) => {
    if (subtabId === 'subpanel-snapshot') {
        const snapTab = document.querySelector('.tab-link[data-target="snapshot-page"]');
        if (snapTab) {
            activateResultTab(snapTab);
            return;
        }
    }

    if (roleScope !== 'admin' && (subtabId === 'subpanel-publish' || subtabId === 'subpanel-promotion')) {
        subtabId = 'subpanel-subjects';
    }

    if (!subtabId) subtabId = (roleScope === 'admin') ? 'subpanel-publish' : 'subpanel-subjects';
    
    // Hide all subpanels and show target
    document.querySelectorAll('.settings-subpanel').forEach((panel) => {
        panel.classList.add('hidden');
    });
    const activePanel = document.getElementById(subtabId);
    if (activePanel) activePanel.classList.remove('hidden');

    // Update section name badge
    const subtabNames = {
        'subpanel-publish': 'Publish Controls',
        'subpanel-subjects': 'Subjects & Exams',
        'subpanel-grades': 'Grade Rules',
        'subpanel-promotion': 'Class Promotion'
    };
    const badge = document.getElementById('current-settings-subtab-badge');
    if (badge) badge.textContent = subtabNames[subtabId] || 'Publish Controls';

    // Highlight active link in hamburger menu
    document.querySelectorAll('.settings-nav-link').forEach((link) => {
        const isCurrent = (link.dataset.subtab === subtabId);
        link.classList.toggle('active', isCurrent);
        if (isCurrent) {
            link.style.background = '#eef2ff';
            link.style.color = '#3730a3';
            link.style.fontWeight = '700';
        } else {
            link.style.background = '';
            link.style.color = '';
            link.style.fontWeight = '';
        }
    });

    // Also sync any subtab buttons if present
    document.querySelectorAll('.settings-subtab-btn').forEach((b) => {
        const isCurrent = (b.dataset.subtab === subtabId);
        b.classList.toggle('active', isCurrent);
        b.classList.toggle('bg-indigo-600', isCurrent);
        b.classList.toggle('text-white', isCurrent);
        b.classList.toggle('text-slate-700', !isCurrent);
    });

    // If promotion subpanel is selected, refresh candidates UI
    if (subtabId === 'subpanel-promotion') {
        renderPromotionCandidatesUI();
    }
    // If publish subpanel is selected, refresh publish controls and history table
    if (subtabId === 'subpanel-publish') {
        renderPublishControls();
        renderBlockedClasses();
        renderPublishedHistoryTable();
    }
};

// Hamburger menu links for Settings & Setup subtabs
document.querySelectorAll('.settings-nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        
        // Switch main page to settings-page
        const settingsPage = document.getElementById('settings-page');
        if (settingsPage) {
            tabs.forEach(t => t.classList.remove('active'));
            pages.forEach(p => p.classList.add('hidden'));
            settingsPage.classList.remove('hidden');
            document.body.classList.remove('marks-entry-active');
            window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
            document.body.classList.remove('modal-scroll-lock');
            
            let subtabId = link.dataset.subtab || 'subpanel-publish';
            if (roleScope !== 'admin' && (subtabId === 'subpanel-publish' || subtabId === 'subpanel-promotion')) {
                subtabId = 'subpanel-subjects';
            }
            activateSettingsSubpanel(subtabId);
            
            if (link.getAttribute('href')?.startsWith('#')) {
                history.pushState({}, '', link.getAttribute('href'));
            }
        }
        
        // Close menu
        navMenu.classList.remove('active');
        mobileMenuBtn?.classList.remove('active-toggle');
    });
});

// Settings & Setup Sub-tab button switcher (if used anywhere)
document.querySelectorAll('.settings-subtab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        const targetSubtab = btn.dataset.subtab;
        activateSettingsSubpanel(targetSubtab);
    });
});

// Click outside handlers for modals, header dropdown menu and kebab menus
document.addEventListener('click', (e) => {
    if (navMenu && navMenu.classList.contains('active')) {
        if (!navMenu.contains(e.target) && !mobileMenuBtn?.contains(e.target)) {
            navMenu.classList.remove('active');
            mobileMenuBtn?.classList.remove('active-toggle');
        }
    }
    if (!e.target.closest('.result-row-menu-toggle') && !e.target.closest('.result-row-menu')) {
        document.querySelectorAll('.result-row-menu').forEach((menu) => menu.classList.add('hidden'));
    }
    if (!e.target.closest('.schema-menu-toggle') && !e.target.closest('.schema-menu')) {
        document.querySelectorAll('.schema-menu').forEach((menu) => menu.classList.add('hidden'));
    }
    // Dismiss modals if clicking on overlay backdrop
    if (e.target.classList.contains('modal-overlay')) {
        const modal = e.target;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        modal.style.display = 'none';
        document.body.classList.remove('modal-scroll-lock');
    }
});

// Escape key dismisses modals and clears any scroll lock
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay').forEach((modal) => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            modal.style.display = 'none';
        });
        document.body.classList.remove('modal-scroll-lock');
        if (navMenu && navMenu.classList.contains('active')) {
            navMenu.classList.remove('active');
            mobileMenuBtn?.classList.remove('active-toggle');
        }
    }
});

// Safeguard: Automatically sync and remove modal-scroll-lock when no modal overlays are visible
const isOverlayVisible = (el) => {
    if (!el || el.classList.contains('hidden') || el.style.display === 'none') return false;
    if (el.style.display === 'flex' || el.style.display === 'block') return true;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
};

const syncBodyScrollLockState = () => {
    const overlays = document.querySelectorAll('.modal-overlay');
    const hasOpenModal = Array.from(overlays).some((m) => isOverlayVisible(m));
    if (!hasOpenModal && document.body.classList.contains('modal-scroll-lock')) {
        document.body.classList.remove('modal-scroll-lock');
    }
};

const setupModalObserver = () => {
    const overlays = document.querySelectorAll('.modal-overlay');
    if (!overlays.length) return;
    const observer = new MutationObserver(() => syncBodyScrollLockState());
    overlays.forEach((el) => {
        observer.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
    });
    syncBodyScrollLockState();
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupModalObserver, { once: true });
} else {
    setupModalObserver();
}

