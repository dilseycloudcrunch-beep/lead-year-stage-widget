let allLeads = [];         // currently loaded (selected year's) leads
let leadsByStatus = {};
let activeStatus = null;
let currentFetchId = 0;    // guards against race conditions between year switches
let ownerIdToName = {};    // maps Owner id -> Owner full name

// Base URL to build direct links to individual Lead records
const LEAD_RECORD_BASE_URL = "https://crmplus.zoho.com/proctorgallagherinstitute/index.do/cxapp/crm/org908687475/tab/Leads/";

// Initialize Zoho Embedded App SDK
ZOHO.embeddedApp.on("PageLoad", async function (data) {
  ZOHO.CRM.UI.Resize({ height: "700px", width: "50%" }).then(function () {
    console.log("Widget resized");
  });

  populateYearDropdown();
  // Thoda delay do taaki SDK ka parent-window bridge fully ready ho jaye
  setTimeout(async function () {
    await fetchAllUsers();          // owner id->name map ek hi baar bana lo
    await fetchLeadsForYear(getSelectedYear());
  }, 400);
});
ZOHO.embeddedApp.init();

function getSelectedYear() {
  return parseInt(document.getElementById("yearSelect").value);
}

// Fetch all CRM Users once, build an id -> full_name map.
async function fetchAllUsers() {
  try {
    const response = await ZOHO.CRM.API.getAllRecords({
      Entity: "users",
      sort_order: "asc",
      per_page: 200
    });
    if (response && response.users) {
      response.users.forEach(user => {
        ownerIdToName[user.id] = user.full_name || user.name || "Unknown";
      });
    }
  } catch (error) {
    console.error("Error fetching Users:", error);
  }
}

// Helper: safely resolve Owner name from the lead's Owner.id via the map
function getOwnerName(lead) {
  const ownerId = lead.Owner && lead.Owner.id;
  if (!ownerId) return null;
  return ownerIdToName[ownerId] || null;
}

// Helper: build a direct link to a Lead's record page
function getLeadRecordUrl(lead) {
  if (!lead || !lead.id) return null;
  return `${LEAD_RECORD_BASE_URL}${lead.id}`;
}

// Populate Year Dropdown dynamically (e.g., last 5 years + next year)
function populateYearDropdown() {
  const yearSelect = document.getElementById("yearSelect");
  const currentYear = new Date().getFullYear();
  for (let year = currentYear + 1; year >= currentYear - 5; year--) {
    const option = document.createElement("option");
    option.value = year;
    option.text = year;
    if (year === currentYear) option.selected = true;
    yearSelect.appendChild(option);
  }
  yearSelect.addEventListener("change", async function () {
    await fetchLeadsForYear(getSelectedYear());
  });
}

// Populate Owner Dropdown dynamically from currently loaded (selected year's) Leads
function populateOwnerDropdown() {
  const ownerSelect = document.getElementById("ownerSelect");
  const previousValue = ownerSelect.value || "All";

  const ownerNames = new Set();
  allLeads.forEach(lead => {
    const ownerName = getOwnerName(lead);
    if (ownerName) ownerNames.add(ownerName);
  });

  ownerSelect.innerHTML = `<option value="All">All Owners</option>`;

  Array.from(ownerNames).sort().forEach(name => {
    const option = document.createElement("option");
    option.value = name;
    option.text = name;
    ownerSelect.appendChild(option);
  });

  if ([...ownerSelect.options].some(o => o.value === previousValue)) {
    ownerSelect.value = previousValue;
  }

  ownerSelect.addEventListener("change", renderStatuses);
}

// Fetch ONLY the selected year's Leads using COQL (Created_Time range),
// split month-by-month to stay under Zoho's 2000-offset limit per query.
// Months are fetched in small parallel batches to balance speed vs rate limits.
async function fetchLeadsForYear(year) {
  const container = document.getElementById("statusContainer");
  container.innerHTML = `<p class="loading-text">Loading Leads for ${year}...</p>`;

  currentFetchId += 1;
  const thisFetchId = currentFetchId;

  const limit = 200;
  const maxOffset = 2000;
  const batchSize = 4; // kitne months ek saath parallel chalenge (rate-limit safe)

  async function fetchMonth(month) {
    const monthStr = String(month).padStart(2, "0");
    const lastDay = new Date(year, month, 0).getDate();
    const startDate = `${year}-${monthStr}-01T00:00:00+00:00`;
    const endDate = `${year}-${monthStr}-${lastDay}T23:59:59+00:00`;

    const monthLeads = [];
    let offset = 0;
    let moreRecords = true;

    while (moreRecords) {
      if (thisFetchId !== currentFetchId) return monthLeads;

      if (offset > maxOffset) {
        console.warn(`Offset limit reached for ${year}-${monthStr}, some records may be skipped.`);
        break;
      }

      const query = `select First_Name, Last_Name, Email, Phone, Lead_Status, Owner, Created_Time from Leads where Created_Time between '${startDate}' and '${endDate}' limit ${limit} offset ${offset}`;

      try {
        const response = await ZOHO.CRM.API.coql({ select_query: query });

        if (thisFetchId !== currentFetchId) return monthLeads;

        if (response && response.data && response.data.length > 0) {
          monthLeads.push(...response.data);
        }

        moreRecords = !!(response && response.info && response.info.more_records) && response.data && response.data.length === limit;
        offset += limit;
      } catch (err) {
        console.error(`Error fetching ${year}-${monthStr}:`, err);
        break;
      }
    }

    return monthLeads;
  }

  try {
    const allMonths = Array.from({ length: 12 }, (_, i) => i + 1);
    const yearLeads = [];

    for (let i = 0; i < allMonths.length; i += batchSize) {
      if (thisFetchId !== currentFetchId) return;

      const batch = allMonths.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(m => fetchMonth(m)));

      if (thisFetchId !== currentFetchId) return;

      batchResults.forEach(leads => yearLeads.push(...leads));
    }

    if (thisFetchId !== currentFetchId) return;

    allLeads = yearLeads;

    if (allLeads.length > 0) {
      populateOwnerDropdown();
      renderStatuses();
    } else {
      container.innerHTML = `<p>No Leads found for ${year}.</p>`;
    }
  } catch (error) {
    if (thisFetchId !== currentFetchId) return;
    console.error("Error fetching Leads:", error);
    container.innerHTML = "<p>Error loading Leads data. Check console (F12) for details.</p>";
  }
}

// Render Status rows (one below another). allLeads is already scoped to the selected year.
function renderStatuses() {
  const selectedOwner = document.getElementById("ownerSelect").value;
  const container = document.getElementById("statusContainer");
  container.innerHTML = "";
  activeStatus = null;

  const filteredLeads = allLeads.filter(lead => {
    if (selectedOwner !== "All") {
      const ownerName = getOwnerName(lead);
      if (ownerName !== selectedOwner) return false;
    }
    return true;
  });

  leadsByStatus = {};
  filteredLeads.forEach(lead => {
    const status = lead.Lead_Status || "Unassigned";
    if (!leadsByStatus[status]) {
      leadsByStatus[status] = [];
    }
    leadsByStatus[status].push(lead);
  });

  if (Object.keys(leadsByStatus).length === 0) {
    container.innerHTML = `<p>No Leads found for the selected filters.</p>`;
    return;
  }

  Object.keys(leadsByStatus).forEach(status => {
    const statusBlock = document.createElement("div");
    statusBlock.className = "status-block";
    statusBlock.id = "status-" + status.replace(/\s+/g, "-");

    const pill = document.createElement("button");
    pill.className = "status-pill";
    pill.type = "button";
    pill.innerHTML = `<span>${status} (${leadsByStatus[status].length})</span><span class="status-arrow">&#9656;</span>`;
    pill.addEventListener("click", () => toggleStatus(status, statusBlock));

    const leadsList = document.createElement("div");
    leadsList.className = "leads-list";
    leadsByStatus[status].forEach(lead => {
      const leadCard = document.createElement("div");
      leadCard.className = "lead-card";
      const ownerName = getOwnerName(lead) || "N/A";
      const recordUrl = getLeadRecordUrl(lead);
      const fullName = [lead.First_Name, lead.Last_Name].filter(Boolean).join(" ") || "Unnamed Lead";

      const leadNameHtml = recordUrl
        ? `<a href="${recordUrl}" target="_blank" rel="noopener noreferrer" style="color:#1d4ed8; text-decoration:none;">${fullName}</a>`
        : fullName;

      leadCard.innerHTML = `
        <div class="lead-name">${leadNameHtml}</div>
        <div class="lead-info">Email: ${lead.Email || "N/A"}</div>
        <div class="lead-info">Phone: ${lead.Phone || "N/A"}</div>
        <div class="lead-info">Owner: ${ownerName}</div>
      `;
      leadsList.appendChild(leadCard);
    });

    statusBlock.appendChild(pill);
    statusBlock.appendChild(leadsList);
    container.appendChild(statusBlock);
  });
}

// Expand/collapse the clicked Status's leads, right below its own row
function toggleStatus(status, statusBlockEl) {
  const wasActive = statusBlockEl.classList.contains("active");

  document.querySelectorAll(".status-block.active").forEach(el => el.classList.remove("active"));

  if (wasActive) {
    activeStatus = null;
  } else {
    activeStatus = status;
    statusBlockEl.classList.add("active");
  }
}