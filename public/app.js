const memberSelect = document.querySelector("#member-select");
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
const membersEditor = document.querySelector("#members-editor");
const daysEditor = document.querySelector("#days-editor");
const saveMembersButton = document.querySelector("#save-members-button");
const saveDaysButton = document.querySelector("#save-days-button");
const settingsFeedback = document.querySelector("#settings-feedback");

const slotLabels = {
  morning: "Matin",
  afternoon: "Après-midi"
};

const weekdayFormatter = new Intl.DateTimeFormat("fr-CH", {
  weekday: "long",
  day: "numeric",
  month: "short"
});

let schedule = null;
let selectedMemberId = "";
let isAdminAuthenticated = false;
let pollingHandle = null;
let isApplyingRemoteUpdate = false;
const POLL_INTERVAL_MS = 5000;

async function loadSchedule() {
  const [scheduleResponse, sessionResponse] = await Promise.all([
    fetch("/api/schedule"),
    fetch("/api/admin/session")
  ]);
  schedule = await scheduleResponse.json();
  const session = await sessionResponse.json();
  isAdminAuthenticated = Boolean(session.authenticated);

  if (!selectedMemberId && schedule.members.length > 0) {
    selectedMemberId = schedule.members[0].id;
  }

  render();
}

function render() {
  renderTitle();
  renderMemberSelect();
  renderAdminState();
  renderSettingsEditors();
  renderTable();
}

function renderTitle() {
  const title = schedule?.config?.title || "Tableau des permanences Grangettes";
  pageTitle.textContent = title;
  document.title = title;
}

function renderMemberSelect() {
  memberSelect.innerHTML = "";

  schedule.members.forEach((member) => {
    const option = document.createElement("option");
    option.value = member.id;
    option.textContent = member.name;
    option.selected = member.id === selectedMemberId;
    memberSelect.append(option);
  });

  const activeMember = schedule.members.find((member) => member.id === selectedMemberId);
  selectionHint.textContent = activeMember
    ? `${activeMember.name} peut s'inscrire sur un créneau libre ou se retirer de son propre créneau.`
    : "Choisissez un membre pour commencer.";
}

function renderAdminState() {
  adminEditors.classList.toggle("is-hidden", !isAdminAuthenticated);
  adminLoginSection.classList.toggle("is-hidden", isAdminAuthenticated);
}

function renderSettingsEditors() {
  if (isApplyingRemoteUpdate) {
    return;
  }

  membersEditor.value = schedule.members.map((member) => member.name).join("\n");
  daysEditor.value = schedule.days.join("\n");
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
      const isOwnedBySelectedMember = ownerId === selectedMemberId;

      button.type = "button";
      button.className = "slot-button";
      button.dataset.day = day;
      button.dataset.slot = slot;

      if (ownerId) {
        button.classList.add("is-claimed");
      }

      if (isOwnedBySelectedMember) {
        button.classList.add("is-owned");
      }

      button.innerHTML = owner
        ? `${owner.name}<span class="status-note">${isOwnedBySelectedMember ? "cliquer pour se retirer" : "créneau occupé"}</span>`
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
    commentCell.append(input);
    tr.append(commentCell);

    tbody.append(tr);
  });

  availabilityTable.append(tbody);
}

async function updateAssignment(memberId, day, slot) {
  const response = await fetch("/api/availability", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ memberId, day, slot })
  });

  schedule = await response.json();
  render();
}

async function updateComment(day, comment) {
  const response = await fetch("/api/comment", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ day, comment })
  });

  schedule = await response.json();
  render();
}

async function updateMembers(memberNames) {
  const members = memberNames.map((name, index) => ({
    id: schedule.members[index]?.id || "",
    name
  }));

  const response = await fetch("/api/members", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ members })
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Impossible d'enregistrer les membres");
  }

  schedule = payload;

  if (!schedule.members.some((member) => member.id === selectedMemberId)) {
    selectedMemberId = schedule.members[0]?.id || "";
  }

  render();
}

async function updateDays(days) {
  const response = await fetch("/api/days", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ days })
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Impossible d'enregistrer les dates");
  }

  schedule = payload;
  render();
}

function schedulesDiffer(nextSchedule) {
  return JSON.stringify(schedule) !== JSON.stringify(nextSchedule);
}

function isEditingField() {
  const activeElement = document.activeElement;

  if (!activeElement) {
    return false;
  }

  const tagName = activeElement.tagName;
  if (tagName !== "TEXTAREA" && tagName !== "INPUT") {
    return false;
  }

  return true;
}

async function refreshScheduleSilently() {
  const response = await fetch("/api/schedule", {
    cache: "no-store"
  });
  const nextSchedule = await response.json();

  if (!schedule || schedulesDiffer(nextSchedule)) {
    if (isEditingField()) {
      return;
    }

    isApplyingRemoteUpdate = false;
    schedule = nextSchedule;

    if (!schedule.members.some((member) => member.id === selectedMemberId)) {
      selectedMemberId = schedule.members[0]?.id || "";
    }

    render();
    isApplyingRemoteUpdate = false;
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

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function checkAdminCredentials(username, password) {
  const response = await fetch("/api/admin/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ username, password })
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Identifiants administrateur invalides");
  }

  isAdminAuthenticated = Boolean(payload.authenticated);
  render();
}

memberSelect.addEventListener("change", (event) => {
  selectedMemberId = event.target.value;
  render();
});

availabilityTable.addEventListener("click", async (event) => {
  const button = event.target.closest(".slot-button");

  if (!button) {
    return;
  }

  const { day, slot } = button.dataset;
  const ownerId = schedule.assignments?.[day]?.[slot] || null;

  if (ownerId && ownerId !== selectedMemberId) {
    return;
  }

  await updateAssignment(selectedMemberId, day, slot);
});

availabilityTable.addEventListener("change", async (event) => {
  const input = event.target.closest(".comment-input");

  if (!input) {
    return;
  }

  await updateComment(input.dataset.day, input.value);
});

resetButton.addEventListener("click", async () => {
  if (!isAdminAuthenticated) {
    settingsFeedback.textContent = "Connexion administrateur requise pour réinitialiser la démo.";
    return;
  }

  const response = await fetch("/api/reset", {
    method: "POST"
  });
  const payload = await response.json();

  if (!response.ok) {
    settingsFeedback.textContent = payload.error || "Impossible de réinitialiser la démo.";
    return;
  }

  schedule = payload;

  if (!schedule.members.some((member) => member.id === selectedMemberId)) {
    selectedMemberId = schedule.members[0]?.id || "";
  }

  settingsFeedback.textContent = "Données de démonstration réinitialisées.";
  render();
});

adminLoginButton.addEventListener("click", async () => {
  try {
    await checkAdminCredentials(adminUsernameInput.value.trim(), adminPasswordInput.value);
    adminFeedback.textContent = "Édition déverrouillée.";
    settingsFeedback.textContent = "";
    adminPasswordInput.value = "";
  } catch (error) {
    adminFeedback.textContent = error.message;
  }
});

adminLogoutButton.addEventListener("click", () => {
  fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
  isAdminAuthenticated = false;
  adminPasswordInput.value = "";
  adminFeedback.textContent = "Accès administrateur verrouillé.";
  settingsFeedback.textContent = "";
  render();
});

saveMembersButton.addEventListener("click", async () => {
  const members = membersEditor.value
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);

  try {
    await updateMembers(members);
    settingsFeedback.textContent = "Liste des membres enregistrée.";
  } catch (error) {
    settingsFeedback.textContent = error.message;
  }
});

saveDaysButton.addEventListener("click", async () => {
  const days = daysEditor.value
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);

  try {
    await updateDays(days);
    settingsFeedback.textContent = "Liste des dates enregistrée.";
  } catch (error) {
    settingsFeedback.textContent = error.message;
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshScheduleSilently().catch(() => {});
  }
});

loadSchedule().catch((error) => {
  selectionHint.textContent = `Impossible de charger le planning : ${error.message}`;
});

startPolling();
