function normalizeQuestionText(value) {
    return (value || '')
        .toString()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeOptionText(value) {
    return normalizeQuestionText(value);
}

function questionSimilarity(a, b) {
    const na = normalizeQuestionText(a);
    const nb = normalizeQuestionText(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.includes(nb) || nb.includes(na)) return 0.92;

    const sa = new Set(na.split(' ').filter(Boolean));
    const sb = new Set(nb.split(' ').filter(Boolean));
    if (!sa.size || !sb.size) return 0;

    let intersection = 0;
    sa.forEach(token => {
        if (sb.has(token)) intersection += 1;
    });
    const union = new Set([...sa, ...sb]).size;
    return union ? intersection / union : 0;
}

function buildOptionSignature(data) {
    const opts = ['option_a', 'option_b', 'option_c', 'option_d', 'option_e']
        .map(key => normalizeOptionText(data[key]))
        .join('||');
    return opts;
}

function optionsSimilarity(a, b) {
    const keys = ['option_a', 'option_b', 'option_c', 'option_d', 'option_e'];
    let same = 0;
    keys.forEach(key => {
        if (normalizeOptionText(a[key]) === normalizeOptionText(b[key])) {
            same += 1;
        }
    });
    return same / keys.length;
}

function weightedSimilarity(parts) {
    const valid = parts.filter(p => typeof p.score === 'number' && typeof p.weight === 'number' && p.weight > 0);
    if (!valid.length) return 0;
    const weightSum = valid.reduce((acc, p) => acc + p.weight, 0);
    const weighted = valid.reduce((acc, p) => acc + (p.score * p.weight), 0);
    return weightSum > 0 ? weighted / weightSum : 0;
}

module.exports = {
    normalizeQuestionText,
    normalizeOptionText,
    questionSimilarity,
    buildOptionSignature,
    optionsSimilarity,
    weightedSimilarity
};
