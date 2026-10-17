import { db, auth } from '../../../config/firebase-config.js';
import { BASE_PATH, formatCurrency, escapeHtml } from '../../shared/app-common.js';
import { appLog } from '../../shared/logger.js';
import { showToast } from '../../shared/toaster.js';
import { collection, doc, writeBatch, getDocs, query, where } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { openFeeEntryEditModal, closeFeeEntryEditModal, submitFeeEntryPayment } from './shared-fee-modal.js';

/**
 * Master Fee Ledger Module
 * Provides edge-to-edge spreadsheet monitoring, consolidated family sibling groupings,
 * multi-parameter sorting & filtering, inline payment recording, and landscape PDF export.
 */

// Module state
let ledgerStudents = [];
let ledgerGroups = [];
let ledgerPayments = [];
let ledgerClasses = ['+2', '+1', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1'];
let ledgerDefaultFee = 200;
let ledgerAcademicYear = '';
let isInitialized = false;

// Filter state
const filters = {
    search: '',
    classFilter: '',
    classOrder: 'DESC', // 'DESC' (+2 to 1) or 'ASC' (1 to +2)
    studentSort: 'DEFAULT', // 'DEFAULT', 'ADM', 'A-Z', 'Z-A'
    genderMode: 'MIXED', // 'MIXED', 'CLASS_BOYS_FIRST', 'GLOBAL_BOYS_FIRST'
    statusFilter: 'ALL' // 'ALL', 'CONCESSION', 'GROUP', 'PENDING'
};

let ledgerRowLimit = 25;
let ledgerPageOffset = 0;

// Bulk Selection State for Master Fee Ledger
// Key: `${unitId}__${month}`, Value: { unitId, month, type: 'pay' | 'edit', paymentId }
const selectedLedgerCells = new Map();

const updateLedgerBulkActionButtons = () => {
    const actionsWrap = document.getElementById('ledger-bulk-actions');
    const collectBtn = document.getElementById('ledger-bulk-collect-btn');
    const collectLabel = document.getElementById('ledger-bulk-collect-label');
    const editBtn = document.getElementById('ledger-bulk-edit-btn');
    const editLabel = document.getElementById('ledger-bulk-edit-label');

    let payCount = 0;
    let editCount = 0;
    selectedLedgerCells.forEach(val => {
        if (val.type === 'pay') payCount += 1;
        else if (val.type === 'edit') editCount += 1;
    });

    if (actionsWrap) {
        const hasAny = payCount > 0 || editCount > 0;
        actionsWrap.classList.toggle('hidden', !hasAny);
        actionsWrap.classList.toggle('flex', hasAny);
    }

    if (collectBtn && collectLabel) {
        collectBtn.classList.toggle('hidden', payCount === 0);
        collectBtn.classList.toggle('flex', payCount > 0);
        collectLabel.textContent = `Collect (${payCount})`;
    }

    if (editBtn && editLabel) {
        editBtn.classList.toggle('hidden', editCount === 0);
        editBtn.classList.toggle('flex', editCount > 0);
        editLabel.textContent = `Edit (${editCount})`;
    }
};

export const clearLedgerBulkSelection = () => {
    selectedLedgerCells.clear();
    document.querySelectorAll('.ledger-cell-select-cb').forEach(cb => {
        cb.checked = false;
        const cell = cb.closest('td');
        if (cell) cell.classList.remove('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
    });
    document.querySelectorAll('.ledger-col-select-all-cb, .ledger-row-select-all-cb').forEach(cb => {
        cb.checked = false;
    });
    updateLedgerBulkActionButtons();
};

const STANDARD_ACADEMIC_MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

// Class ranking helper
const getClassRank = (cls = '') => {
    const text = String(cls || '').trim().toUpperCase();
    if (text.includes('+2') || text.includes('PLUS TWO') || text === '12') return 12;
    if (text.includes('+1') || text.includes('PLUS ONE') || text === '11') return 11;
    const match = text.match(/\d+/);
    if (match) return parseInt(match[0], 10);
    if (text.includes('UKG')) return 0.2;
    if (text.includes('LKG')) return 0.1;
    return 0;
};

// Match payment itemKey with month
const isMonthMatch = (itemKey = '', month = '') => {
    const key = String(itemKey || '').trim().toLowerCase();
    const m = String(month || '').trim().toLowerCase();
    return key === m || key.includes(m) || key === `month_${m}`;
};

// Next receipt number helper
const getNextReceiptNumber = () => {
    let maxRcpt = 0;
    (ledgerPayments || []).forEach(p => {
        const num = parseInt(p.receiptNo, 10);
        if (!isNaN(num) && num > maxRcpt) maxRcpt = num;
    });
    return maxRcpt + 1;
};

// Group resolving logic
const buildLedgerUnits = () => {
    const studentMap = new Map();
    ledgerStudents.forEach(s => studentMap.set(s.id, s));

    const processedStudentIds = new Set();
    const units = [];

    // 1. Process defined student groups (family / siblings)
    ledgerGroups.forEach(group => {
        const memberIds = Array.isArray(group.memberIds) ? group.memberIds : [];
        const members = memberIds.map(id => studentMap.get(id)).filter(Boolean);

        if (members.length > 0) {
            members.forEach(m => processedStudentIds.add(m.id));

            // Sort siblings by class high to low, then name
            members.sort((a, b) => getClassRank(b.class || b.studentClass) - getClassRank(a.class || a.studentClass) || (a.name || '').localeCompare(b.name || ''));

            const primary = members[0];
            const groupFee = Number(group.fee || group.amount || (ledgerDefaultFee * members.length));
            const guardianName = group.guardianName || primary.guardian || primary.father || 'Guardian';
            const contactPhone = group.phone || primary.phone || primary.mobile || '';

            // Calculate month payments for group
            const monthStatus = {};
            STANDARD_ACADEMIC_MONTHS.forEach(month => {
                // Check if any payment was made for this group or its members for this month
                const matchedPayment = ledgerPayments.find(p => {
                    const isGroupPay = p.billingGroupId === group.id && isMonthMatch(p.itemKey, month);
                    const isMemberPay = memberIds.includes(p.studentId) && isMonthMatch(p.itemKey, month);
                    return isGroupPay || isMemberPay;
                });

                if (matchedPayment) {
                    monthStatus[month] = {
                        isPaid: true,
                        amount: Number(matchedPayment.amount || groupFee),
                        receipt: matchedPayment.receiptNo || 'Paid',
                        date: matchedPayment.paymentDate || (matchedPayment.timestamp ? new Date(matchedPayment.timestamp).toLocaleDateString('en-GB') : '-'),
                        paymentId: matchedPayment.id || null
                    };
                } else {
                    monthStatus[month] = {
                        isPaid: false,
                        due: groupFee,
                        receipt: '',
                        date: ''
                    };
                }
            });

            units.push({
                id: `group_${group.id}`,
                isGroup: true,
                groupId: group.id,
                groupName: group.name || 'Family Group',
                students: members,
                classes: members.map(m => m.class || m.studentClass || '-'),
                guardian: guardianName,
                phone: contactPhone,
                fee: groupFee,
                isConcession: false,
                extraFees: { total: 0, balance: 0 },
                arrears: 0,
                monthStatus
            });
        }
    });

    // 2. Process ungrouped individual students
    ledgerStudents.forEach(s => {
        if (!processedStudentIds.has(s.id)) {
            const hasConcession = s.concessionFee !== undefined && s.concessionFee !== null && s.concessionFee !== '';
            const indFee = hasConcession ? Number(s.concessionFee) : ledgerDefaultFee;
            const sClass = s.class || s.studentClass || '-';

            const monthStatus = {};
            STANDARD_ACADEMIC_MONTHS.forEach(month => {
                const matchedPayment = ledgerPayments.find(p => p.studentId === s.id && isMonthMatch(p.itemKey, month));

                if (matchedPayment) {
                    monthStatus[month] = {
                        isPaid: true,
                        amount: Number(matchedPayment.amount || indFee),
                        receipt: matchedPayment.receiptNo || 'Paid',
                        date: matchedPayment.paymentDate || (matchedPayment.timestamp ? new Date(matchedPayment.timestamp).toLocaleDateString('en-GB') : '-'),
                        paymentId: matchedPayment.id || null
                    };
                } else {
                    monthStatus[month] = {
                        isPaid: false,
                        due: indFee,
                        receipt: '',
                        date: ''
                    };
                }
            });

            units.push({
                id: s.id,
                isGroup: false,
                groupId: null,
                groupName: '',
                students: [s],
                classes: [sClass],
                guardian: s.guardian || s.father || 'Guardian',
                phone: s.phone || s.mobile || '',
                fee: indFee,
                isConcession: hasConcession,
                extraFees: { total: 0, balance: 0 },
                arrears: 0,
                monthStatus
            });
        }
    });

    return units;
};

// Filter & Sort Pipeline
const getFilteredUnits = () => {
    let list = buildLedgerUnits();

    // 1. Search Query (Name, Adm, Guardian, Phone)
    if (filters.search.trim()) {
        const q = filters.search.trim().toLowerCase();
        list = list.filter(u => {
            const matchName = u.students.some(s => (s.name || '').toLowerCase().includes(q));
            const matchAdm = u.students.some(s => String(s.adm || '').toLowerCase().includes(q));
            const matchGuardian = String(u.guardian || '').toLowerCase().includes(q);
            const matchPhone = String(u.phone || '').includes(q);
            return matchName || matchAdm || matchGuardian || matchPhone;
        });
    }

    // 2. Class Filter
    if (filters.classFilter) {
        list = list.filter(u => u.classes.includes(filters.classFilter));
    }

    // 3. Status Filter
    if (filters.statusFilter === 'GROUP') {
        list = list.filter(u => u.isGroup);
    } else if (filters.statusFilter === 'CONCESSION') {
        list = list.filter(u => u.isConcession);
    } else if (filters.statusFilter === 'PENDING') {
        list = list.filter(u => Object.values(u.monthStatus).some(m => !m.isPaid));
    }

    // Helper for max class rank of a unit
    const getUnitClassRank = (u) => {
        const ranks = u.classes.map(c => getClassRank(c));
        return Math.max(...ranks, 0);
    };

    // 4. Sorting & Gender arrangement
    list.sort((a, b) => {
        // A. Class Order sorting
        const rankA = getUnitClassRank(a);
        const rankB = getUnitClassRank(b);
        const classDiff = filters.classOrder === 'DESC' ? (rankB - rankA) : (rankA - rankB);

        // B. Gender Mode logic
        if (filters.genderMode === 'GLOBAL_BOYS_FIRST') {
            const hasFemaleA = a.students.some(s => (s.gender || '').toUpperCase() === 'F' || (s.gender || '').toLowerCase() === 'female');
            const hasFemaleB = b.students.some(s => (s.gender || '').toUpperCase() === 'F' || (s.gender || '').toLowerCase() === 'female');
            if (!hasFemaleA && hasFemaleB) return -1;
            if (hasFemaleA && !hasFemaleB) return 1;
        }

        if (classDiff !== 0) return classDiff;

        if (filters.genderMode === 'CLASS_BOYS_FIRST') {
            const hasFemaleA = a.students.some(s => (s.gender || '').toUpperCase() === 'F' || (s.gender || '').toLowerCase() === 'female');
            const hasFemaleB = b.students.some(s => (s.gender || '').toUpperCase() === 'F' || (s.gender || '').toLowerCase() === 'female');
            if (!hasFemaleA && hasFemaleB) return -1;
            if (hasFemaleA && !hasFemaleB) return 1;
        }

        // C. Student Sorting
        if (filters.studentSort === 'ADM') {
            const admA = parseInt(a.students[0]?.adm, 10) || 0;
            const admB = parseInt(b.students[0]?.adm, 10) || 0;
            return admA - admB;
        } else if (filters.studentSort === 'A-Z') {
            return (a.students[0]?.name || '').localeCompare(b.students[0]?.name || '');
        } else if (filters.studentSort === 'Z-A') {
            return (b.students[0]?.name || '').localeCompare(a.students[0]?.name || '');
        }

        // Default: By student name
        return (a.students[0]?.name || '').localeCompare(b.students[0]?.name || '');
    });

    return list;
};

// Render toolbar filter controls
const renderFilterControls = () => {
    // Populate Class Filter Dropdown
    const classFilterSelect = document.getElementById('ledger-class-filter');
    if (classFilterSelect) {
        const uniqueClasses = [...new Set(ledgerStudents.map(s => s.class || s.studentClass).filter(Boolean))]
            .sort((a, b) => getClassRank(b) - getClassRank(a));

        let opts = `<option value="">Filter: All Classes</option>`;
        uniqueClasses.forEach(c => {
            opts += `<option value="${escapeHtml(c)}" ${filters.classFilter === c ? 'selected' : ''}>Class: ${escapeHtml(c)}</option>`;
        });
        classFilterSelect.innerHTML = opts;
    }

    // Populate Class Order Dropdown dynamically
    const classOrderSelect = document.getElementById('ledger-class-order');
    if (classOrderSelect) {
        const detectedRanks = ledgerStudents.map(s => s.class || s.studentClass).filter(Boolean)
            .sort((a, b) => getClassRank(b) - getClassRank(a));
        const highestClass = detectedRanks[0] || '+2';
        const lowestClass = detectedRanks[detectedRanks.length - 1] || '1';

        classOrderSelect.innerHTML = `
            <option value="DESC" ${filters.classOrder === 'DESC' ? 'selected' : ''}>Class Order: ${escapeHtml(highestClass)} to ${escapeHtml(lowestClass)}</option>
            <option value="ASC" ${filters.classOrder === 'ASC' ? 'selected' : ''}>Class Order: ${escapeHtml(lowestClass)} to ${escapeHtml(highestClass)}</option>
        `;
    }
};

// Render Table
const renderLedgerTable = () => {
    const tableContainer = document.getElementById('master-ledger-table-container');
    if (!tableContainer) return;

    const list = getFilteredUnits();

    if (list.length === 0) {
        tableContainer.innerHTML = `
            <div class="text-center py-16 text-slate-400 bg-white rounded-2xl border border-slate-200">
                <i class="fas fa-folder-open text-4xl mb-3 block text-slate-300"></i>
                <p class="font-bold text-sm text-slate-600">No records found matching current filters.</p>
                <p class="text-xs text-slate-400 mt-1">Try resetting search or filter options.</p>
                <button id="ledger-reset-empty-btn" class="mt-4 px-4 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-xl text-xs font-bold transition">Clear All Filters</button>
            </div>
        `;
        document.getElementById('ledger-reset-empty-btn')?.addEventListener('click', resetFilters);
        return;
    }

    const totalUnitsCount = list.length;
    if (ledgerPageOffset >= totalUnitsCount) {
        ledgerPageOffset = Math.max(0, Math.floor((totalUnitsCount - 1) / ledgerRowLimit) * ledgerRowLimit);
    }

    const visibleList = list.slice(ledgerPageOffset, ledgerPageOffset + ledgerRowLimit);
    const startNumber = totalUnitsCount > 0 ? ledgerPageOffset + 1 : 0;
    const endNumber = ledgerPageOffset + visibleList.length;

    let html = `
        <table class="min-w-full text-xs text-left border-collapse border border-slate-200 bg-white shadow-sm master-ledger-sticky-table">
            <thead class="bg-slate-50 text-[11px] font-black text-slate-700 uppercase tracking-wider border-b border-slate-200 sticky top-0 z-30 shadow-xs">
                <tr>
                    <th class="px-2.5 py-3.5 text-center border-r border-slate-200 w-12 sticky left-0 bg-slate-50 z-35">NO</th>
                    <th class="px-2.5 py-3.5 text-center border-r border-slate-200 w-16 sticky left-12 bg-slate-50 z-35">CLASS</th>
                    <th class="px-3.5 py-3.5 border-r border-slate-200 min-w-[220px] sticky left-28 bg-slate-50 z-35">STUDENT NAME</th>
                    <th class="px-3.5 py-3.5 border-r border-slate-200 min-w-[190px]">GUARDIAN & CONTACT</th>
                    <th class="px-3 py-3.5 text-center border-r border-slate-200 min-w-[130px] text-amber-900 bg-amber-50/50">GROUP SETUP</th>
                    <th class="px-2.5 py-3.5 text-center border-r border-slate-200 min-w-[110px] text-emerald-900 bg-emerald-50/50">EXTRA FEES</th>
                    <th class="px-2 py-3.5 text-center border-r border-slate-200 w-16 text-rose-900 bg-rose-50/40">ARREARS</th>
                    ${STANDARD_ACADEMIC_MONTHS.map(m => `
                        <th class="px-2 py-2.5 text-center border-r border-slate-200 min-w-[98px]">
                            <div class="flex flex-col items-center gap-1">
                                <span>${m.toUpperCase()}</span>
                                <input type="checkbox" class="ledger-col-select-all-cb w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer" data-month="${m}" title="Select all unpaid in ${m}">
                            </div>
                        </th>
                    `).join('')}
                </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 font-medium">
    `;

    visibleList.forEach((unit, idx) => {
        const serialNo = ledgerPageOffset + idx + 1;
        const rowBg = idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/40';
        const isRowAllSelected = STANDARD_ACADEMIC_MONTHS.every(m => selectedLedgerCells.has(`${unit.id}__${m}`));

        // Student Names markup with numbering and gender badges
        const studentNamesHtml = unit.students.map((s, sIdx) => {
            const genderVal = (s.gender || '').toUpperCase();
            const isFem = genderVal === 'F' || genderVal === 'FEMALE';
            const genderBadge = isFem
                ? `<span class="text-[10px] font-extrabold text-pink-600 bg-pink-50 px-1 py-0.5 rounded border border-pink-100 ml-1.5">(F)</span>`
                : `<span class="text-[10px] font-extrabold text-blue-600 bg-blue-50 px-1 py-0.5 rounded border border-blue-100 ml-1.5">(M)</span>`;
            const prefix = unit.isGroup ? `<span class="text-blue-600 font-bold">${sIdx + 1}. </span>` : '';

            return `
                <div class="flex items-center gap-1 leading-snug py-0.5">
                    ${prefix}
                    <span class="font-bold text-slate-800 uppercase hover:text-blue-600 cursor-pointer" title="Adm: ${escapeHtml(s.adm || '--')}">${escapeHtml(s.name || 'Student')}</span>
                    ${genderBadge}
                </div>
            `;
        }).join('');

        // Classes markup
        const classesHtml = unit.classes.map(c => `
            <div class="font-bold text-slate-800 text-[11px] leading-snug py-0.5">${escapeHtml(c)}</div>
        `).join('');

        // Group Setup badge
        const groupSetupHtml = unit.isGroup
            ? `<div class="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl border border-slate-300 bg-white text-slate-800 font-bold text-xs shadow-sm" title="Family group with ${unit.students.length} siblings">
                 <i class="fas fa-link text-slate-400 text-[10px]"></i> ₹${unit.fee} (${unit.students.length})
               </div>`
            : `<div class="inline-flex items-center justify-center px-3 py-1 rounded-xl border border-slate-200 bg-white text-slate-700 font-bold text-xs">
                 ₹${unit.fee}
               </div>`;

        html += `
            <tr class="${rowBg} hover:bg-blue-50/40 transition-colors">
                <!-- NO -->
                <td class="px-2.5 py-3 text-center font-bold text-slate-500 border-r border-slate-200 sticky left-0 ${rowBg} z-20">
                    ${serialNo}
                </td>

                <!-- CLASS -->
                <td class="px-2.5 py-3 text-center font-black border-r border-slate-200 sticky left-12 ${rowBg} z-20">
                    ${classesHtml}
                </td>

                <!-- STUDENT NAME -->
                <td class="px-3.5 py-3 border-r border-slate-200 sticky left-28 ${rowBg} z-20">
                    <div class="flex items-center justify-between gap-2">
                        <div class="space-y-0.5 min-w-0">
                            ${studentNamesHtml}
                        </div>
                        <input type="checkbox" class="ledger-row-select-all-cb w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer flex-shrink-0" data-unit-id="${escapeHtml(unit.id)}" ${isRowAllSelected ? 'checked' : ''} title="Select all months for this student/group">
                    </div>
                </td>

                <!-- GUARDIAN & CONTACT -->
                <td class="px-3.5 py-3 border-r border-slate-200">
                    <div class="font-bold text-slate-800 text-xs uppercase">${escapeHtml(unit.guardian)}</div>
                    <div class="flex items-center gap-1.5 text-[11px] text-slate-500 font-mono mt-0.5">
                        <span>${escapeHtml(unit.phone || '--')}</span>
                        ${unit.phone ? `
                            <button type="button" class="copy-phone-btn text-slate-400 hover:text-slate-600 transition" data-phone="${escapeHtml(unit.phone)}" title="Copy phone">
                                <i class="fas fa-copy text-[10px]"></i>
                            </button>
                        ` : ''}
                    </div>
                </td>

                <!-- GROUP SETUP -->
                <td class="px-3 py-3 text-center border-r border-slate-200 bg-amber-50/20">
                    ${groupSetupHtml}
                </td>

                <!-- EXTRA FEES -->
                <td class="px-2.5 py-3 text-center border-r border-slate-200 bg-emerald-50/20">
                    <div class="border border-emerald-200/80 bg-emerald-50/60 rounded-xl px-2 py-1 inline-block text-center leading-tight">
                        <div class="text-[10px] font-bold text-emerald-800">Total: ₹0</div>
                        <div class="text-[10px] font-semibold text-emerald-700">Balance: ₹0</div>
                    </div>
                </td>

                <!-- ARREARS -->
                <td class="px-2 py-3 text-center font-bold text-slate-500 border-r border-slate-200 bg-rose-50/20">
                    0
                </td>

                <!-- 12 ACADEMIC MONTHS -->
                ${STANDARD_ACADEMIC_MONTHS.map(month => {
                    const st = unit.monthStatus[month] || { isPaid: false, due: unit.fee };
                    const selKey = `${unit.id}__${month}`;
                    const isSelected = selectedLedgerCells.has(selKey);
                    const selRing = isSelected ? 'ring-2 ring-blue-500 ring-inset bg-blue-50/70' : '';

                    if (st.isPaid) {
                        return `
                            <td class="px-1.5 py-2 text-center border-r border-slate-200 bg-emerald-50/50 fee-cell-interactive cursor-pointer hover:bg-emerald-100 transition relative ${selRing}"
                                data-ledger-action="view-receipt" data-payment-id="${st.paymentId || ''}" data-unit-id="${unit.id}" data-month="${month}" title="Click to view receipt or tick checkbox to bulk edit">
                                <div class="flex items-center justify-between mb-0.5 px-0.5">
                                    <input type="checkbox" class="ledger-cell-select-cb w-3.5 h-3.5 rounded border-emerald-400 text-amber-600 focus:ring-amber-500 cursor-pointer"
                                        data-sel-key="${escapeHtml(selKey)}"
                                        data-unit-id="${escapeHtml(unit.id)}"
                                        data-month="${escapeHtml(month)}"
                                        data-sel-type="edit"
                                        data-payment-id="${escapeHtml(st.paymentId || '')}"
                                        ${isSelected ? 'checked' : ''}
                                        title="Select to bulk edit">
                                    <div class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[9px] font-black border border-emerald-200">
                                        <i class="fas fa-check text-[7px]"></i> Paid
                                    </div>
                                </div>
                                <div class="flex flex-col items-center justify-center">
                                    <div class="text-[9px] font-mono font-bold text-emerald-850 truncate max-w-[85px]" title="${escapeHtml(st.receipt)}">${st.receipt ? `R:${escapeHtml(st.receipt)}` : 'Paid'}</div>
                                    <div class="text-[9px] text-emerald-600 font-medium">${escapeHtml(st.date)}</div>
                                </div>
                            </td>
                        `;
                    }

                    return `
                        <td class="px-1.5 py-2 text-center border-r border-slate-200 bg-white fee-cell-interactive cursor-pointer hover:bg-blue-50 transition relative ${selRing}"
                            data-ledger-action="pay-fee" data-unit-id="${unit.id}" data-month="${month}" data-fee="${unit.fee}" title="Click to record fee payment or tick checkbox for multi-entry">
                            <div class="flex items-center justify-between mb-1 px-0.5">
                                <input type="checkbox" class="ledger-cell-select-cb w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                                    data-sel-key="${escapeHtml(selKey)}"
                                    data-unit-id="${escapeHtml(unit.id)}"
                                    data-month="${escapeHtml(month)}"
                                    data-sel-type="pay"
                                    data-fee="${unit.fee}"
                                    ${isSelected ? 'checked' : ''}
                                    title="Select to collect together">
                                <span class="text-[9px] font-black text-rose-500">Unpaid</span>
                            </div>
                            <div class="flex flex-col items-center justify-center">
                                <button type="button" class="ledger-quick-pay-btn w-full py-0.5 bg-blue-50 hover:bg-blue-600 hover:text-white text-blue-700 rounded-md font-bold text-[10px] transition border border-blue-200 shadow-2xs">
                                    Pay
                                </button>
                            </div>
                        </td>
                    `;
                }).join('')}
            </tr>
        `;
    });

    html += `
            </tbody>
        </table>
    `;

    const hasPrevPage = ledgerPageOffset > 0;
    const hasNextPage = endNumber < totalUnitsCount;

    if (totalUnitsCount > 0) {
        html += `
            <div class="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3.5 bg-slate-50 border-t border-slate-200">
                <span class="text-xs font-bold text-slate-600">
                    Showing <span class="text-slate-900 font-extrabold">${startNumber} - ${endNumber}</span> of <span class="text-slate-900 font-extrabold">${totalUnitsCount}</span> records
                </span>
                <div class="flex items-center gap-2">
                    <button type="button" id="ledger-prev-btn" ${!hasPrevPage ? 'disabled' : ''} class="px-4 py-2 ${hasPrevPage ? 'bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 cursor-pointer' : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'} rounded-xl text-xs font-extrabold shadow-2xs transition inline-flex items-center gap-1.5">
                        <i class="fas fa-arrow-left text-[10px]"></i>
                        <span>Previous</span>
                    </button>
                    <button type="button" id="ledger-load-next-btn" ${!hasNextPage ? 'disabled' : ''} class="px-5 py-2 ${hasNextPage ? 'bg-blue-600 hover:bg-blue-700 text-white cursor-pointer' : 'bg-slate-200 text-slate-400 cursor-not-allowed'} rounded-xl text-xs font-extrabold shadow-xs transition inline-flex items-center gap-1.5">
                        <span>Next</span>
                        <i class="fas fa-arrow-right text-[10px]"></i>
                    </button>
                </div>
            </div>
        `;
    }

    const prevScrollLeft = tableContainer.scrollLeft;
    tableContainer.innerHTML = html;
    tableContainer.scrollTop = 0;
    tableContainer.scrollLeft = prevScrollLeft;

    document.getElementById('ledger-prev-btn')?.addEventListener('click', () => {
        if (ledgerPageOffset > 0) {
            ledgerPageOffset = Math.max(0, ledgerPageOffset - ledgerRowLimit);
            renderLedgerTable();
        }
    });

    document.getElementById('ledger-load-next-btn')?.addEventListener('click', () => {
        if (ledgerPageOffset + ledgerRowLimit < totalUnitsCount) {
            ledgerPageOffset += ledgerRowLimit;
            renderLedgerTable();
        }
    });

    // Attach event handlers for interactive checkboxes & buttons
    attachTableEventHandlers(list);
    updateLedgerBulkActionButtons();
};

// Event handlers on table elements
const attachTableEventHandlers = (currentUnits) => {
    // 1. Phone copy
    document.querySelectorAll('.copy-phone-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const phone = btn.dataset.phone;
            if (phone) {
                navigator.clipboard?.writeText(phone);
                showToast(`Copied phone: ${phone}`, 'success');
            }
        });
    });

    // 1b. Column Header "Select All in Month" Checkboxes
    document.querySelectorAll('.ledger-col-select-all-cb').forEach(colCb => {
        colCb.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        colCb.addEventListener('change', (e) => {
            const month = colCb.dataset.month;
            const shouldCheck = colCb.checked;
            const monthCbs = Array.from(document.querySelectorAll(`.ledger-cell-select-cb[data-month="${month}"][data-sel-type="pay"]`));
            const targetCbs = monthCbs.length > 0
                ? monthCbs
                : Array.from(document.querySelectorAll(`.ledger-cell-select-cb[data-month="${month}"]`));

            targetCbs.forEach(cb => {
                cb.checked = shouldCheck;
                const selKey = cb.dataset.selKey;
                const td = cb.closest('td');
                if (shouldCheck) {
                    selectedLedgerCells.set(selKey, {
                        unitId: cb.dataset.unitId,
                        month: cb.dataset.month,
                        type: cb.dataset.selType,
                        paymentId: cb.dataset.paymentId || '',
                        fee: Number(cb.dataset.fee || 200)
                    });
                    if (td) td.classList.add('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
                } else {
                    selectedLedgerCells.delete(selKey);
                    if (td) td.classList.remove('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
                }
            });
            updateLedgerBulkActionButtons();
        });
    });

    // 1b-row. Student Row "Select All Months for Student/Group" Checkboxes
    document.querySelectorAll('.ledger-row-select-all-cb').forEach(rowCb => {
        rowCb.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        rowCb.addEventListener('change', () => {
            const unitId = rowCb.dataset.unitId;
            const shouldCheck = rowCb.checked;
            const unpaidRowCbs = Array.from(document.querySelectorAll(`.ledger-cell-select-cb[data-unit-id="${CSS.escape(unitId)}"][data-sel-type="pay"]`));
            const targetCbs = unpaidRowCbs.length > 0
                ? unpaidRowCbs
                : Array.from(document.querySelectorAll(`.ledger-cell-select-cb[data-unit-id="${CSS.escape(unitId)}"]`));

            targetCbs.forEach(cb => {
                cb.checked = shouldCheck;
                const selKey = cb.dataset.selKey;
                const td = cb.closest('td');
                if (shouldCheck) {
                    selectedLedgerCells.set(selKey, {
                        unitId: cb.dataset.unitId,
                        month: cb.dataset.month,
                        type: cb.dataset.selType,
                        paymentId: cb.dataset.paymentId || '',
                        fee: Number(cb.dataset.fee || 200)
                    });
                    if (td) td.classList.add('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
                } else {
                    selectedLedgerCells.delete(selKey);
                    if (td) td.classList.remove('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
                }
            });
            updateLedgerBulkActionButtons();
        });
    });

    // 1c. Individual Cell Checkboxes
    document.querySelectorAll('.ledger-cell-select-cb').forEach(cb => {
        cb.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        cb.addEventListener('change', () => {
            const selKey = cb.dataset.selKey;
            const td = cb.closest('td');
            if (cb.checked) {
                selectedLedgerCells.set(selKey, {
                    unitId: cb.dataset.unitId,
                    month: cb.dataset.month,
                    type: cb.dataset.selType,
                    paymentId: cb.dataset.paymentId || '',
                    fee: Number(cb.dataset.fee || 200)
                });
                if (td) td.classList.add('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
            } else {
                selectedLedgerCells.delete(selKey);
                if (td) td.classList.remove('ring-2', 'ring-blue-500', 'ring-inset', 'bg-blue-50/70');
            }
            updateLedgerBulkActionButtons();
        });
    });

    // 2. Cell Action clicks (Pay or View Receipt)
    const tableContainer = document.getElementById('master-ledger-table-container');
    if (tableContainer) {
        tableContainer.onclick = (e) => {
            if (e.target.closest('.ledger-cell-select-cb') || e.target.closest('.ledger-col-select-all-cb') || e.target.closest('.ledger-row-select-all-cb')) {
                return;
            }
            const viewCell = e.target.closest('[data-ledger-action="view-receipt"]');
            if (viewCell) {
                const paymentId = viewCell.dataset.paymentId;
                const unitId = viewCell.dataset.unitId;
                const month = viewCell.dataset.month;
                let payment = ledgerPayments.find(p => paymentId && p.id === paymentId);
                if (!payment && unitId) {
                    const unit = currentUnits.find(u => u.id === unitId);
                    if (unit) {
                        const mIds = unit.students.map(s => s.id);
                        payment = ledgerPayments.find(p => (p.billingGroupId === unit.groupId || mIds.includes(p.studentId)) && isMonthMatch(p.itemKey, month));
                    }
                }
                if (payment && typeof window.openPaymentReceiptDetailModal === 'function') {
                    window.openPaymentReceiptDetailModal(payment.id || paymentId, viewCell);
                } else {
                    showToast('Receipt details not found.', 'info');
                }
                return;
            }

            const payCell = e.target.closest('[data-ledger-action="pay-fee"]');
            if (payCell) {
                const unitId = payCell.dataset.unitId;
                const month = payCell.dataset.month;
                const unit = currentUnits.find(u => u.id === unitId);
                if (unit) {
                    openQuickPayModal(unit, month, payCell);
                }
                return;
            }
        };
    }
};

// Trigger Bulk Collect or Bulk Edit Modal for selected cells in Master Fee Ledger
const openLedgerBulkActionModal = (actionType = 'pay') => {
    const allUnits = buildLedgerUnits();
    const bulkItems = [];

    selectedLedgerCells.forEach((sel, selKey) => {
        if (sel.type !== actionType) return;
        const unit = allUnits.find(u => u.id === sel.unitId);
        if (!unit) return;

        const cbEl = document.querySelector(`.ledger-cell-select-cb[data-sel-key="${CSS.escape(selKey)}"]`);
        const cellEl = cbEl ? cbEl.closest('td') : null;
        const studentNames = unit.students.map(s => s.name).join(', ');
        const studentClasses = unit.classes.join(', ');
        const primaryStudent = unit.students[0] || {};

        if (actionType === 'pay') {
            bulkItems.push({
                unitId: unit.id,
                studentId: primaryStudent.id || unit.id,
                studentName: unit.isGroup ? `${studentNames} (Group)` : studentNames,
                studentClass: studentClasses,
                studentAdm: unit.students.map(s => s.adm).filter(Boolean).join(', '),
                guardian: unit.guardian || '',
                billingGroupId: unit.isGroup ? unit.groupId : null,
                month: sel.month,
                itemKey: sel.month.toLowerCase(),
                itemName: unit.isGroup ? `${sel.month} Tuition Fee (Family Group)` : `${sel.month} Tuition Fee`,
                itemType: 'month',
                amount: Number(unit.fee || sel.fee || ledgerDefaultFee || 200),
                academicYear: ledgerAcademicYear,
                targetCellElement: cellEl
            });
        } else if (actionType === 'edit') {
            const mIds = unit.students.map(s => s.id);
            const payment = ledgerPayments.find(p => (sel.paymentId && p.id === sel.paymentId) || ((p.billingGroupId === unit.groupId || mIds.includes(p.studentId)) && isMonthMatch(p.itemKey, sel.month)));
            if (payment) {
                bulkItems.push({
                    paymentId: payment.id,
                    payment: payment,
                    studentId: payment.studentId || primaryStudent.id,
                    studentName: payment.studentName || studentNames,
                    studentClass: payment.studentClass || studentClasses,
                    guardian: unit.guardian || payment.guardianName || '',
                    month: sel.month,
                    itemKey: payment.itemKey || sel.month.toLowerCase(),
                    itemName: payment.itemName || `${sel.month} Tuition Fee`,
                    amount: Number(payment.amount || unit.fee || 200),
                    academicYear: payment.academicYear || ledgerAcademicYear,
                    targetCellElement: cellEl
                });
            }
        }
    });

    if (bulkItems.length === 0) {
        showToast('No valid items selected.', 'info');
        return;
    }

    openFeeEntryEditModal({
        source: 'master-ledger',
        mode: actionType === 'edit' ? 'bulk-edit' : 'bulk-add',
        bulkItems: bulkItems,
        academicYear: ledgerAcademicYear,
        onUpdated: () => {
            clearLedgerBulkSelection();
        }
    });
};

// Open Quick Pay Modal for recording new payment in Master Ledger
export const openQuickPayModal = (unit, month, targetCellElement = null) => {
    if (!unit) return;
    openFeeEntryEditModal({
        source: 'master-ledger',
        mode: 'add',
        unit: unit,
        month: month,
        itemKey: month.toLowerCase(),
        itemName: `${month} Tuition Fee`,
        defaultAmount: unit.fee,
        targetCellElement: targetCellElement,
        academicYear: ledgerAcademicYear
    });
};

// Open Quick Pay Modal for an individual student (Fee Status compatibility adapter)
export const openStudentQuickPayModal = ({ studentId, studentName, studentClass, studentAdm, guardian, month, itemKey, defaultAmount, targetCellElement }) => {
    openFeeEntryEditModal({
        source: 'fee-status',
        mode: 'add',
        student: {
            id: studentId,
            name: studentName,
            class: studentClass,
            adm: studentAdm,
            guardian: guardian
        },
        month: month,
        itemKey: itemKey || month,
        itemName: month ? `${month} Tuition Fee` : 'Tuition Fee',
        defaultAmount: defaultAmount || ledgerDefaultFee || 200,
        targetCellElement: targetCellElement,
        academicYear: ledgerAcademicYear
    });
};
window.openStudentQuickPayModal = openStudentQuickPayModal;

// Open in-place Edit Modal for existing payment without redirecting to Fee Entry
export const openEditPaymentInQuickModal = (payment, targetCellElement = null) => {
    if (!payment) return;
    openFeeEntryEditModal({
        mode: 'edit',
        payment: payment,
        targetCellElement: targetCellElement,
        academicYear: payment.academicYear || ledgerAcademicYear
    });
};
window.openEditPaymentInQuickModal = openEditPaymentInQuickModal;

// Close Quick Pay Modal
export const closeQuickPayModal = () => {
    closeFeeEntryEditModal();
};

// Process and Save Fee Payment (Delegates to shared submission utility)
export const submitLedgerPayment = async () => {
    return submitFeeEntryPayment();
};

// Export to Landscape PDF
const exportLedgerPdf = () => {
    if (!window.jspdf?.jsPDF) {
        showToast('PDF generator is loading, please try again.', 'info');
        return;
    }

    const list = getFilteredUnits();
    if (list.length === 0) {
        showToast('No records available to export.', 'error');
        return;
    }

    const docPdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const conf = window.institutionConfig || {};
    const instName = conf.appName || document.getElementById('header-title')?.textContent || 'Noorul Islam Madrasa';
    const place = conf.place || document.getElementById('header-place')?.textContent?.trim() || '';
    const regNo = conf.regNo || document.getElementById('header-regno')?.textContent?.trim() || '';

    const pageWidth = docPdf.internal.pageSize.getWidth();

    // Header
    docPdf.setFont('helvetica', 'bold');
    docPdf.setFontSize(14);
    docPdf.setTextColor(15, 23, 42);
    docPdf.text(instName.toUpperCase(), pageWidth / 2, 28, { align: 'center' });

    docPdf.setFont('helvetica', 'normal');
    docPdf.setFontSize(9);
    docPdf.setTextColor(100, 116, 139);
    const subtitle = [place, regNo ? `Reg No: ${regNo}` : '', `Academic Year: ${ledgerAcademicYear || 'Current'}`].filter(Boolean).join(' • ');
    docPdf.text(subtitle, pageWidth / 2, 42, { align: 'center' });

    docPdf.setFont('helvetica', 'bold');
    docPdf.setFontSize(11);
    docPdf.setTextColor(30, 41, 59);
    docPdf.text('MASTER FEE LEDGER & CONSOLIDATED REGISTER', 20, 60);

    docPdf.setFont('helvetica', 'normal');
    docPdf.setFontSize(8);
    docPdf.text(`Generated on: ${new Date().toLocaleString('en-GB')} | Total Records: ${list.length}`, pageWidth - 20, 60, { align: 'right' });

    // Table Columns
    const head = [
        ['NO', 'CLASS', 'STUDENT NAME', 'GUARDIAN & PHONE', 'GROUP', ...STANDARD_ACADEMIC_MONTHS.map(m => m.toUpperCase()), 'STATUS']
    ];

    const body = list.map((unit, idx) => {
        const studentNamesStr = unit.students.map((s, i) => `${unit.isGroup ? `${i + 1}. ` : ''}${s.name} (${s.gender === 'F' ? 'F' : 'M'})`).join('\n');
        const classesStr = unit.classes.join('\n');
        const guardianStr = `${unit.guardian}\n${unit.phone || '--'}`;
        const groupStr = unit.isGroup ? `Group (${unit.students.length})\n₹${unit.fee}` : `₹${unit.fee}`;

        const monthValues = STANDARD_ACADEMIC_MONTHS.map(m => {
            const st = unit.monthStatus[m];
            if (st?.isPaid) {
                const rcpt = st.receipt && String(st.receipt).trim() !== '' && st.receipt !== 'Paid'
                    ? String(st.receipt).trim()
                    : 'Paid';
                return rcpt;
            }
            return '';
        });

        const allPaid = Object.values(unit.monthStatus).every(m => m.isPaid);
        const overallStatus = allPaid ? 'Completed' : '';

        return [
            idx + 1,
            classesStr,
            studentNamesStr,
            guardianStr,
            groupStr,
            ...monthValues,
            overallStatus
        ];
    });

    docPdf.autoTable({
        startY: 70,
        head,
        body,
        theme: 'grid',
        styles: {
            fontSize: 7,
            cellPadding: 3,
            lineColor: [226, 232, 240],
            lineWidth: 0.5,
            valign: 'middle'
        },
        headStyles: {
            fillColor: [15, 23, 42],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            halign: 'center'
        },
        columnStyles: {
            0: { cellWidth: 24, halign: 'center' },
            1: { cellWidth: 38, halign: 'center', fontStyle: 'bold' },
            2: { cellWidth: 120 },
            3: { cellWidth: 100 },
            4: { cellWidth: 46, halign: 'center' }
        },
        didParseCell: (data) => {
            if (data.section === 'body' && data.column.index >= 5 && data.column.index <= 16) {
                const cellText = String(data.cell.raw || '').trim();
                data.cell.styles.halign = 'center';
                if (cellText) {
                    data.cell.styles.textColor = [15, 23, 42];
                    data.cell.styles.fontStyle = 'bold';
                }
            }
        }
    });

    docPdf.save(`master-fee-ledger-${new Date().toISOString().split('T')[0]}.pdf`);
    showToast('Master Fee Ledger PDF downloaded!', 'success');
};

// Reset all filter controls
const resetFilters = () => {
    filters.search = '';
    filters.classFilter = '';
    filters.classOrder = 'DESC';
    filters.studentSort = 'DEFAULT';
    filters.genderMode = 'MIXED';
    filters.statusFilter = 'ALL';
    ledgerPageOffset = 0;

    const searchInput = document.getElementById('ledger-search-input');
    if (searchInput) searchInput.value = '';

    const classFilter = document.getElementById('ledger-class-filter');
    if (classFilter) classFilter.value = '';

    const classOrder = document.getElementById('ledger-class-order');
    if (classOrder) classOrder.value = 'DESC';

    const studentSort = document.getElementById('ledger-student-sort');
    if (studentSort) studentSort.value = 'DEFAULT';

    const genderMode = document.getElementById('ledger-gender-mode');
    if (genderMode) genderMode.value = 'MIXED';

    const statusFilter = document.getElementById('ledger-status-filter');
    if (statusFilter) statusFilter.value = 'ALL';

    clearLedgerBulkSelection();
    renderLedgerTable();
};

// Public update hook to sync with collection-page.js data
export const updateMasterLedgerData = ({ students, groups, payments, classes, defaultFee, academicYear }) => {
    if (Array.isArray(students)) ledgerStudents = students;
    if (Array.isArray(groups)) ledgerGroups = groups;
    if (Array.isArray(payments)) ledgerPayments = payments;
    if (Array.isArray(classes)) ledgerClasses = classes;
    if (typeof defaultFee === 'number') ledgerDefaultFee = defaultFee;
    if (academicYear) ledgerAcademicYear = academicYear;

    renderFilterControls();
    renderLedgerTable();
};

// Initialize Module UI & Listeners
export const initMasterLedgerModule = () => {
    if (isInitialized) return;
    isInitialized = true;

    appLog('info', 'collection.masterLedger', 'Master Fee Ledger module initialized');

    // 0. Rows Limit Listener
    const rowLimitSelect = document.getElementById('ledger-row-limit');
    if (rowLimitSelect) {
        rowLimitSelect.addEventListener('change', (e) => {
            ledgerRowLimit = parseInt(e.target.value, 10) || 25;
            ledgerPageOffset = 0;
            renderLedgerTable();
        });
    }

    // 1. Search Input Listener
    const searchInput = document.getElementById('ledger-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            filters.search = e.target.value;
            ledgerPageOffset = 0;
            renderLedgerTable();
        });
    }

    // 2. Class Filter Listener
    const classFilter = document.getElementById('ledger-class-filter');
    if (classFilter) {
        classFilter.addEventListener('change', (e) => {
            filters.classFilter = e.target.value;
            ledgerPageOffset = 0;
            renderLedgerTable();
        });
    }

    // 3. Class Order Listener
    const classOrder = document.getElementById('ledger-class-order');
    if (classOrder) {
        classOrder.addEventListener('change', (e) => {
            filters.classOrder = e.target.value;
            ledgerPageOffset = 0;
            renderLedgerTable();
        });
    }

    // 4. Student Sort Listener
    const studentSort = document.getElementById('ledger-student-sort');
    if (studentSort) {
        studentSort.addEventListener('change', (e) => {
            filters.studentSort = e.target.value;
            ledgerPageOffset = 0;
            renderLedgerTable();
        });
    }

    // 5. Gender Mode Listener
    const genderMode = document.getElementById('ledger-gender-mode');
    if (genderMode) {
        genderMode.addEventListener('change', (e) => {
            filters.genderMode = e.target.value;
            ledgerPageOffset = 0;
            renderLedgerTable();
        });
    }

    // 6. Status Filter Listener
    const statusFilter = document.getElementById('ledger-status-filter');
    if (statusFilter) {
        statusFilter.addEventListener('change', (e) => {
            filters.statusFilter = e.target.value;
            ledgerPageOffset = 0;
            renderLedgerTable();
        });
    }

    // 7. Clear Filters & Selection Button
    const clearBtn = document.getElementById('ledger-clear-filters-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (selectedLedgerCells.size > 0) {
                clearLedgerBulkSelection();
                showToast('Selection cleared.', 'info');
            } else {
                resetFilters();
            }
        });
    }

    // 7b. Bulk Collect & Bulk Edit Buttons
    document.getElementById('ledger-bulk-collect-btn')?.addEventListener('click', () => openLedgerBulkActionModal('pay'));
    document.getElementById('ledger-bulk-edit-btn')?.addEventListener('click', () => openLedgerBulkActionModal('edit'));

    // 8. PDF Export Button
    const pdfBtn = document.getElementById('master-ledger-pdf-btn');
    if (pdfBtn) {
        pdfBtn.addEventListener('click', exportLedgerPdf);
    }

    // 9. Quick Pay Modal Close & Submit Buttons
    document.getElementById('ledger-pay-cancel-btn')?.addEventListener('click', closeQuickPayModal);
    document.getElementById('ledger-pay-close-x')?.addEventListener('click', closeQuickPayModal);
    document.getElementById('ledger-pay-confirm-btn')?.addEventListener('click', submitLedgerPayment);

    // Initial render
    renderFilterControls();
    renderLedgerTable();
};

window.MasterLedger = {
    init: initMasterLedgerModule,
    update: updateMasterLedgerData,
    render: renderLedgerTable,
    renderTable: renderLedgerTable,
    exportPdf: exportLedgerPdf,
    openQuickPayModal: openQuickPayModal,
    openStudentQuickPayModal: openStudentQuickPayModal,
    openEditPaymentInQuickModal: openEditPaymentInQuickModal,
    get ledgerPayments() { return ledgerPayments; },
    set ledgerPayments(val) { ledgerPayments = val; },
    get academicYear() { return ledgerAcademicYear; }
};
