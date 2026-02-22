let questions = [];
let mode = 'training';

async function loadQuestions(selectedMode) {
    mode = selectedMode;
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = 'index.html';
        return;
    }

    const res = await fetch(`http://localhost:5000/api/questions?mode=${mode}`, {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    questions = data.questions;
    displayQuestions();
}

function displayQuestions() {
    const form = document.getElementById('qcmForm');
    form.innerHTML = '';

    questions.forEach((q, index) => {
        const div = document.createElement('div');
        div.classList.add('question');

        div.innerHTML = `
            <p><b>${index + 1}. ${q.question}</b></p>

            <label><input type="checkbox" name="q${q.id}" value="A"> ${q.option_a}</label><br>
            <label><input type="checkbox" name="q${q.id}" value="B"> ${q.option_b}</label><br>
            <label><input type="checkbox" name="q${q.id}" value="C"> ${q.option_c}</label><br>
            <label><input type="checkbox" name="q${q.id}" value="D"> ${q.option_d}</label><br>
            <label><input type="checkbox" name="q${q.id}" value="E"> ${q.option_e}</label>
        `;

        form.appendChild(div);
    });
}


async function submitAnswers() {
    const answers = questions.map(q => {
        const checked = document.querySelectorAll(
            `input[name="q${q.id}"]:checked`
        );

        return {
            id: q.id,
            selectedOptions: Array.from(checked).map(c => c.value)
        };
    });

    const token = localStorage.getItem('token');

    const res = await fetch(
        'http://localhost:5000/api/questions/submit',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ answers })
        }
    );

    const data = await res.json();

    document.getElementById('result').textContent =
        `Score : ${data.score} / ${data.total}`;

    // SHOW CORRECTIONS
    data.corrections.forEach(c => {
        const inputs = document.querySelectorAll(
            `input[name="q${c.id}"]`
        );

        inputs.forEach(input => {
            const label = input.parentElement;

            if (c.correctOptions.includes(input.value)) {
                label.classList.add('correct');
            }

            if (
                c.selectedOptions.includes(input.value) &&
                !c.correctOptions.includes(input.value)
            ) {
                label.classList.add('wrong');
            }

            input.disabled = true;
        });
    });
}

async function loadModulesForStudents() {
    const res = await fetch('http://localhost:5000/api/modules');
    const modules = await res.json();

    const select = document.getElementById('moduleSelect');
    select.innerHTML = '<option value="">Tous les modules</option>';

    modules.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        select.appendChild(opt);
    });
}

async function loadQuestionsByModule() {
    const moduleId = document.getElementById('moduleSelect').value;
    const url = moduleId
        ? `http://localhost:5000/api/questions?module=${moduleId}`
        : `http://localhost:5000/api/questions`;

    const token = localStorage.getItem('token');

    const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token }
    });

    const data = await res.json();
    questions = data.questions;
    displayQuestions();
}


