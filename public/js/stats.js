'use strict';

// Analytics disabled — stats.mirotalk.com tracking removed.
// This file is intentionally a no-op stub.

console.log('STATS', window.location);

const statsDataKey = 'statsData';
const statsData = window.sessionStorage.getItem(statsDataKey);

const apiUrl = window.location.origin + '/stats';

if (statsData) {
    setStats(JSON.parse(statsData));
} else {
    fetch(apiUrl)
        .then((response) => {
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        })
        .then((data) => {
            setStats(data);
            window.sessionStorage.setItem(statsDataKey, JSON.stringify(data));
        })
        .catch((error) => {
            console.error('Stats fetch error:', error);
        });
}

function setStats(data) {
    console.log('STATS', data);
    // Analytics injection disabled — STATS_ENABLED=false in .env
    // The external stats.mirotalk.com script will never be loaded.
}
