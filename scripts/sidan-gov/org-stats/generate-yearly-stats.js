import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { generateYearlyStatsJson, saveStatsJson } from './generate-yearly-org-stats-json.js';
import { getConfig, getRepoRoot } from './config-loader.js';

async function fetchGitHubStats(githubToken) {
    const config = getConfig();
    const repoRoot = getRepoRoot();

    // Use the first npm package as the main one
    const mainPkgKey = Object.keys(config.npmPackages)[0];
    const mainPkgName = config.npmPackages[mainPkgKey];

    // Search for the main package in package.json
    const corePackageJsonResponse = await axios.get(
        'https://api.github.com/search/code',
        {
            params: {
                q: `"${mainPkgName}" in:file filename:package.json`
            },
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `token ${githubToken}`
            }
        }
    );

    // Search for the main package in any file
    const coreAnyFileResponse = await axios.get(
        'https://api.github.com/search/code',
        {
            params: {
                q: `"${mainPkgName}"`
            },
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `token ${githubToken}`
            }
        }
    );

    // Read core_in_repositories data from file (fallback value)
    const coreInReposPath = path.join(repoRoot, config.outputPaths.baseDir, config.outputPaths.statsDir, 'core-in-repositories.json');
    let coreInReposData = { last_updated: '', core_in_repositories: 0 };
    if (fs.existsSync(coreInReposPath)) {
        coreInReposData = JSON.parse(fs.readFileSync(coreInReposPath, 'utf8'));
    }

    return {
        core_in_package_json: corePackageJsonResponse.data.total_count,
        core_in_any_file: coreAnyFileResponse.data.total_count,
        core_in_repositories: coreInReposData.core_in_repositories
    };
}

async function fetchMonthlyDownloads(packageName, year) {
    const downloads = [];
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;

    for (let month = 1; month <= 12; month++) {
        // Skip future months
        if (year === currentYear && month > currentMonth) {
            downloads.push({
                month,
                downloads: 0
            });
            continue;
        }

        const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
        const endDate = new Date(year, month, 0).toISOString().split('T')[0];

        try {
            const response = await axios.get(
                `https://api.npmjs.org/downloads/point/${startDate}:${endDate}/${packageName}`
            );
            downloads.push({
                month,
                downloads: response.data.downloads
            });
        } catch (error) {
            console.error(`Error fetching downloads for ${packageName} in ${year}-${month}:`, error.message);
            downloads.push({
                month,
                downloads: 0
            });
        }
    }
    return downloads;
}

async function loadPreviousStats(year) {
    const config = getConfig();
    const repoRoot = getRepoRoot();
    try {
        const statsPath = path.join(repoRoot, config.outputPaths.baseDir, config.outputPaths.statsDir, `sidan-yearly-stats-${year}.json`);
        console.log(`Attempting to load previous stats from: ${statsPath}`);

        if (fs.existsSync(statsPath)) {
            console.log(`Found existing stats file for ${year}`);
            const content = fs.readFileSync(statsPath, 'utf8');
            return JSON.parse(content);
        } else {
            console.log(`No existing stats file found for ${year}`);
        }
    } catch (error) {
        console.error(`Error loading previous stats for ${year}:`, error);
    }
    return { github: {} };
}

async function main() {
    const config = getConfig();
    const currentYear = new Date().getFullYear();
    const years = Array.from({ length: currentYear - 2023 }, (_, i) => 2024 + i);
    const githubToken = process.env.GITHUB_TOKEN;
    const currentMonth = new Date().getMonth();
    const currentMonthName = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ][currentMonth];

    if (!githubToken) {
        console.error('GITHUB_TOKEN environment variable is required');
        process.exit(1);
    }

    try {
        console.log(`Starting Yearly ${config.organization.displayName} Stats Generation...\n`);

        for (const year of years) {
            console.log(`\n=== Processing year ${year} ===`);

            // Load previous stats
            const previousStats = await loadPreviousStats(year);
            console.log(`Previous stats loaded for ${year}:`, previousStats);

            // Initialize monthlyGitHubStats with previous stats
            const monthlyGitHubStats = {};
            if (previousStats?.githubStats) {
                // Convert array format to object format for easier updates
                previousStats.githubStats.forEach(monthData => {
                    monthlyGitHubStats[monthData.month] = {
                        projects: monthData.projects,
                        files: monthData.files,
                        repositories: monthData.repositories
                    };
                });
            }

            // Only fetch and update GitHub stats for current year and current month
            if (year === currentYear) {
                console.log(`Fetching current GitHub stats for ${currentMonthName} ${year}`);
                // Fetch current GitHub stats
                const currentGitHubStats = await fetchGitHubStats(githubToken);

                // Only update current month's stats if they've increased
                const currentMonthStats = monthlyGitHubStats[currentMonthName] || {
                    projects: 0,
                    files: 0,
                    repositories: 0
                };
                console.log(`Current month stats before update:`, currentMonthStats);
                console.log(`New GitHub stats:`, currentGitHubStats);

                // Only update if it's the current month
                if (currentMonth === new Date().getMonth()) {
                    if (currentGitHubStats.core_in_package_json > currentMonthStats.projects ||
                        currentGitHubStats.core_in_any_file > currentMonthStats.files ||
                        currentGitHubStats.core_in_repositories > currentMonthStats.repositories) {
                        console.log(`Updating current month stats for ${currentMonthName} as new numbers are higher`);
                        monthlyGitHubStats[currentMonthName] = {
                            projects: currentGitHubStats.core_in_package_json,
                            files: currentGitHubStats.core_in_any_file,
                            repositories: currentGitHubStats.core_in_repositories
                        };
                    }
                }
            }

            // Fetch monthly downloads for all packages
            const monthlyDownloads = {};
            for (const [key, pkgName] of Object.entries(config.npmPackages)) {
                monthlyDownloads[key] = await fetchMonthlyDownloads(pkgName, year);
            }
            // Generate and save JSON stats
            const statsData = generateYearlyStatsJson(year, monthlyDownloads, monthlyGitHubStats);
            saveStatsJson(statsData);
        }

        console.log('\nYearly stats generated successfully!');
    } catch (error) {
        console.error('Error generating yearly stats:', error);
        process.exit(1);
    }
}

main();
