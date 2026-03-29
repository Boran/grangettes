const memberSelect = document.querySelector("#member-select");
const memberCodeInput = document.querySelector("#member-code");
const memberLoginButton = document.querySelector("#member-login-button");
const memberLogoutButton = document.querySelector("#member-logout-button");
const pageTitle = document.querySelector("#page-title");
const selectionHint = document.querySelector("#selection-hint");
const availabilityTable = document.querySelector("#availability-table");
const resetButton = document.querySelector("#reset-button");
const adminLoginSection = document.querySelector("#admin-login");
const adminEditors = document.querySelector("#admin-editors");
const adminUsernameInput = document.querySelector("#admin-username");
const adminPasswordInput = document.querySelector("#admin-password");
const adminLoginButton = document.querySelector("#admin-login-button");
const adminLogoutButton = document.querySelector("#admin-logout-button");
const adminFeedback = document.querySelector("#admin-feedback");
const daysEditor = document.querySelector("#days-editor");
const saveDaysButton = document.querySelector("#save-days-button");
const settingsFeedback = document.querySelector("#settings-feedback");
const membersAdminList = document.querySelector("#members-admin-list");
const newMemberNameInput = document.querySelector("#new-member-name");
const addMemberButton = document.querySelector("#add-member-button");
const memberAdminFeedback = document.querySelector("#member-admin-feedback");
const memberCodeOutput = document.querySelector("#member-code-output");
const auditLogList = document.querySelector("#audit-log-list");

const slotLabels = {
  morning: "Matin",
  afternoon: "Apres-midi"
};

const weekdayFormatter = new Intl.DateTimeFormat("fr-CH", {
  weekday: "long",
  day: "numeric",
  month: "short"
});

const dateTimeFormatter = new Intl.DateTimeFormat("fr-CH", {
  dateStyle: "short",
  timeStyle: "short"
});

const POLL_INTERVAL_MS = 5000;

let schedule = null;
let adminSession = null;
let memberSession = null;
let pollingHandle = null;

async function loadAppState() {
  const [scheduleResponse, adminSessionResponse, memberSessionResponse] = await Promise.all([
    fetch("/api/schedule"),
    fetch("/api/admin/session"),
    fetch("/api/member/session")
  ]);

  schedule = await scheduleResponse.json();
  adminSession = await adminSessionResponse.json();
  memberSession = await memberSessionResponse.json();

  render();

  if (adminSession.authenticated) {
    await refreshAuditLog();
  }
}

function render() {
  renderTitle();
  renderMemberAuth();
  renderAdminState();
  renderDaysEditor();
  renderMembersAdmin();
  renderTable();
}

function renderTitle() {
  const title = schedule?.config?.title || "Tableau des permanences Grangettes";
  pageTitle.textContent = title;
  document.title = title;
}

function renderMemberAuth() {
  memberSelect.innerHTML = "";

  schedule.members
    .filter((member) => member.active)
    .forEach((member) => {
      const option = document.createElement("option");
      option.value = member.id;
      option.textContent = member.name;
      memberSelect.append(option);
    });

  const isAuthenticated = Boolean(memberSession?.authenticated);
  memberSelect.disabled = isAuthenticated;
  memberCodeInput.disabled = isAuthenticated;
  memberLoginButton.classList.toggle("is-hidden", isAuthenticated);
  memberLogoutButton.classList.toggle("is-hidden", !isAuthenticated);

  if (isAuthenticated) {
    selectionHint.textContent = `${memberSession.member.name} est connecte et peut modifier ses propres creneaux.`;
    memberSelect.value = memberSession.member.id;
    return;
  }

  selectionHint.textContent = "Connectez-vous avec votre code d'acces pour modifier vos permanences.";
}

function renderAdminState() {
  const isAuthenticated = Boolean(adminSession?.authenticated);
  adminEditors.classList.toggle("is-hidden", !isAuthenticated);
  adminLoginSection.classList.toggle("is-hidden", isAuthenticated);
}

function renderDaysEditor() {
  if (document.activeElement !== daysEditor) {
    daysEditor.value = schedule.days.join("\n");
  }
}

function renderMembersAdmin() {
  membersAdminList.innerHTML = "";

  schedule.members.forEach((member) => {
    const row = document.createElement("div");
    row.className = "member-admin-row";
    row.dataset.memberId = member.id;

    const nameInput = document.createElement("input");
    nameInput.className = "settings-input member-name-input";
    nameInput.value = member.name;
    nameInput.dataset.memberId = member.id;

    const status = document.createElement("div");
    status.className = "member-admin-meta";
    status.textContent = member.hasAccessCode ? "Code actif" : "Aucun code";

    const activeLabel = document.createElement("label");
    activeLabel.className = "member-toggle";
    const activeCheckbox = document.createElement("input");
    activeCheckbox.type = "checkbox";
    activeCheckbox.checked = Boolean(member.active);
    activeCheckbox.dataset.memberId = member.id;
    activeCheckbox.className = "member-active-checkbox";
    activeLabel.append(activeCheckbox, document.createTextNode("Actif"));

    const saveButton = document.createElement("button");
    saveButton.className = "secondary-button";
    saveButton.type = "button";
    saveButton.textContent = "Enregistrer";
    saveButton.dataset.memberId = member.id;
    saveButton.dataset.action = "save-member";

    const regenerateButton = document.createElement("button");
    regenerateButton.className = "secondary-button";
    regenerateButton.type = "button";
    regenerateButton.textContent = "Regenerer le code";
    regenerateButton.dataset.memberId = member.id;
    regenerateButton.dataset.action = "regenerate-code";

    const actions = document.createElement("div");
    actions.className = "admin-actions";
    actions.append(saveButton, regenerateButton);

    row.append(nameInput, status, activeLabel, actions);
    membersAdminList.append(row);
  });
}

function showMemberCode(message) {
  memberCodeOutput.textContent = message;
  memberCodeOutput.classList.remove("is-hidden");
}

function clearMemberCode() {
  memberCodeOutput.textContent = "";
  memberCodeOutput.classList.add("is-hidden");
}

function renderAuditLog(items = []) {
  auditLogList.innerHTML = "";

  if (items.length === 0) {
    auditLogList.textContent = "Aucune action recente.";
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("article");
    row.className = "audit-item";
    row.innerHTML = `
      <strong>${item.actorLabel}</strong>
      <span>${describeAuditAction(item)}</span>
      <span class="status-note">${dateTimeFormatter.format(new Date(item.createdAt))}</span>
    `;
    auditLogList.append(row);
  });
}

function describeAuditAction(item) {
  const day = item.details?.day || "";

  switch (item.action) {
    case "assignment_set":
      return `a attribue ${item.details.slot} le ${day}`;
    case "assignment_cleared":
      return `a libere ${item.details.slot} le ${day}`;
    case "comment_updated":
      return `a modifie un commentaire pour le ${day}`;
    case "member_created":
      return `a cree le membre ${item.details.name}`;
    case "member_updated":
      return `a mis a jour ${item.details.name}`;
    case "member_code_regenerated":
      return "a regenere un code d'acces membre";
    case "days_updated":
      return "a mis a jour la liste des dates";
    case "schedule_reset":
      return "a reinitialise le planning";
    case "admin_login":
      return "s'est connecte en admin";
    case "admin_logout":
      return "s'est deconnecte de l'admin";
    case "member_login":
      return "s'est connecte comme membre";
    case "member_logout":
      return "s'est deconnecte";
    default:
      return item.action;
  }
}

function renderTable() {
  availabilityTable.innerHTML = "";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const dateHeader = document.createElement("th");
  dateHeader.className = "member-column";
  dateHeader.textContent = "Date";
  headerRow.append(dateHeader);

  schedule.slots.forEach((slot) => {
    const th = document.createElement("th");
    th.className = "slot-header";
    th.textContent = slotLabels[slot];
    headerRow.append(th);
  });

  const commentHeader = document.createElement("th");
  commentHeader.className = "slot-header";
  commentHeader.textContent = "Commentaires";
  headerRow.append(commentHeader);

  thead.append(headerRow);
  availabilityTable.append(thead);

  const tbody = document.createElement("tbody");
  const currentMemberId = memberSession?.member?.id || null;

  schedule.days.forEach((day) => {
    const tr = document.createElement("tr");
    const dayCell = document.createElement("th");
    dayCell.className = "member-column";
    dayCell.innerHTML = `${capitalize(weekdayFormatter.format(new Date(`${day}T12:00:00`)))}<span class="date-subtitle">${day}</span>`;
    tr.append(dayCell);

    schedule.slots.forEach((slot) => {
      const td = document.createElement("td");
      td.className = "slot-cell";
      const button = document.createElement("button");
      const ownerId = schedule.assignments?.[day]?.[slot] || null;
      const owner = schedule.members.find((member) => member.id === ownerId);
      const isOwnedByCurrentMember = ownerId === currentMemberId;

      button.type = "button";
      button.className = "slot-button";
      button.dataset.day = day;
      button.dataset.slot = slot;
      button.disabled = !currentMemberId || (ownerId && !isOwnedByCurrentMember);

      if (ownerId) {
        button.classList.add("is-claimed");
      }

      if (isOwnedByCurrentMember) {
        button.classList.add("is-owned");
      }

      button.innerHTML = owner
        ? `${owner.name}<span class="status-note">${isOwnedByCurrentMember ? "cliquer pour se retirer" : "creneau occupe"}</span>`
        : '<span class="status-note">Cliquer pour s\'inscrire</span>';

      td.append(button);
      tr.append(td);
    });

    const commentCell = document.createElement("td");
    commentCell.className = "comment-cell";
    const input = document.createElement("textarea");
    input.className = "comment-input";
    input.dataset.day = day;
    input.placeholder = "Ajouter un commentaire pour cette date";
    input.value = schedule.assignments?.[day]?.comment || "";
    input.disabled = !memberSession?.authenticated && !adminSession?.authenticated;
    commentCell.append(input);
    tr.append(commentCell);

    tbody.append(tr);
  });

  availabilityTable.append(tbody);
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function schedulesDiffer(nextSchedule) {
  return JSON.stringify(schedule) !== JSON.stringify(nextSchedule);
}

function isEditingField() {
  const activeElement = document.activeElement;
  return Boolean(activeElement && (activeElement.tagName === "TEXTAREA" || activeElement.tagName === "INPUT"));
}

async function refreshScheduleSilently() {
  const response = await fetch("/api/schedule", { cache: "no-store" });
  const nextSchedule = await response.json();

  if (!schedule || schedulesDiffer(nextSchedule)) {
    if (isEditingField()) {
      return;
    }

    schedule = nextSchedule;
    render();
  }

  if (adminSession?.authenticated) {
    await refreshAuditLog();
  }
}

function startPolling() {
  if (pollingHandle) {
    return;
  }

  pollingHandle = window.setInterval(() => {
    refreshScheduleSilently().catch(() => {});
  }, POLL_INTERVAL_MS);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Erreur");
  }

  return payload;
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Erreur");
  }

  return payload;
}

async function refreshAuditLog() {
  const response = await fetch("/api/admin/audit");

  if (!response.ok) {
    return;
  }

  const payload = await response.json();
  renderAuditLog(payload.items || []);
}

memberLoginButton.addEventListener("click", async () => {
  try {
    memberSession = await postJson("/api/member/login", {
      memberId: memberSelect.value,
      accessCode: memberCodeInput.value
    });
    memberCodeInput.value = "";
    await loadAppState();
  } catch (error) {
    selectionHint.textContent = error.message;
  }
});

memberLogoutButton.addEventListener("click", async () => {
  await fetch("/api/member/logout", { method: "POST" }).catch(() => {});
  memberSession = null;
  await loadAppState();
});

adminLoginButton.addEventListener("click", async () => {
  try {
    adminSession = await postJson("/api/admin/login", {
      username: adminUsernameInput.value.trim(),
      password: adminPasswordInput.value
    });
    adminPasswordInput.value = "";
    adminFeedback.textContent = "Administration deverrouillee.";
    await loadAppState();
  } catch (error) {
    adminFeedback.textContent = error.message;
  }
});

adminLogoutButton.addEventListener("click", async () => {
  await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
  adminSession = null;
  adminFeedback.textContent = "Administration verrouillee.";
  await loadAppState();
});

availabilityTable.addEventListener("click", async (event) => {
  const button = event.target.closest(".slot-button");
  if (!button || !memberSession?.authenticated) {
    return;
  }

  try {
    schedule = await putJson("/api/availability", {
      memberId: memberSession.member.id,
      day: button.dataset.day,
      slot: button.dataset.slot
    });
    render();
  } catch (error) {
    selectionHint.textContent = error.message;
  }
});

availabilityTable.addEventListener("change", async (event) => {
  const input = event.target.closest(".comment-input");
  if (!input) {
    return;
  }

  try {
    schedule = await putJson("/api/comment", {
      day: input.dataset.day,
      comment: input.value
    });
    render();
  } catch (error) {
    selectionHint.textContent = error.message;
  }
});

saveDaysButton.addEventListener("click", async () => {
  try {
    schedule = await putJson("/api/days", {
      days: daysEditor.value
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
    });
    settingsFeedback.textContent = "Dates enregistrees.";
    render();
  } catch (error) {
    settingsFeedback.textContent = error.message;
  }
});

resetButton.addEventListener("click", async () => {
  try {
    schedule = await postJson("/api/reset");
    settingsFeedback.textContent = "Planning reinitialise depuis le seed.";
    render();
    await refreshAuditLog();
  } catch (error) {
    settingsFeedback.textContent = error.message;
  }
});

addMemberButton.addEventListener("click", async () => {
  try {
    const payload = await postJson("/api/admin/members", {
      name: newMemberNameInput.value
    });
    schedule = payload.schedule;
    newMemberNameInput.value = "";
    memberAdminFeedback.textContent = "Membre cree.";
    showMemberCode(`Code d'acces pour ${payload.member.name}: ${payload.accessCode}`);
    render();
    await refreshAuditLog();
  } catch (error) {
    clearMemberCode();
    memberAdminFeedback.textContent = error.message;
  }
});

membersAdminList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const memberId = button.dataset.memberId;
  const row = button.closest(".member-admin-row");
  const nameInput = row.querySelector(".member-name-input");
  const activeCheckbox = row.querySelector(".member-active-checkbox");

  try {
    if (button.dataset.action === "save-member") {
      const payload = await putJson(`/api/admin/members/${encodeURIComponent(memberId)}`, {
        name: nameInput.value,
        active: activeCheckbox.checked
      });
      schedule = payload.schedule;
      memberAdminFeedback.textContent = "Membre enregistre.";
      clearMemberCode();
    }

    if (button.dataset.action === "regenerate-code") {
      const payload = await postJson(`/api/admin/members/${encodeURIComponent(memberId)}/regenerate-code`);
      schedule = payload.schedule;
      memberAdminFeedback.textContent = "Code membre regenere.";
      showMemberCode(`Nouveau code d'acces: ${payload.accessCode}`);
    }

    render();
    await refreshAuditLog();
  } catch (error) {
    clearMemberCode();
    memberAdminFeedback.textContent = error.message;
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshScheduleSilently().catch(() => {});
  }
});

loadAppState().catch((error) => {
  selectionHint.textContent = `Impossible de charger le planning : ${error.message}`;
});

startPolling();
