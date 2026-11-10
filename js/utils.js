// Get GitHub username from repository URL
export function getGitHubUserInfo() {
  const currentUrl = window.location.href;
  let githubUsername = 'User';
  let githubAvatarUrl = 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png';
  let githubRepo = 'mygamelist';

  const repoMatch = currentUrl.match(/github\.io\/([^\/]+)/);
  if (repoMatch) {
    githubUsername = currentUrl.split('.github.io')[0].split('//')[1];
    githubAvatarUrl = `https://github.com/${githubUsername.toLowerCase()}.png`;
    githubRepo = repoMatch[1];
  }

  return { username: githubUsername, avatarUrl: githubAvatarUrl, repo: githubRepo };
}

// Percentage calculation
export function calculatePercentage(unlocked, total) {
    return total > 0 ? Math.round((unlocked / total) * 100) : 0;
}

// Date formatting
export function formatUnlockDate(timestamp) {
    return new Date(timestamp * 1000).toLocaleDateString();
}

// ==========================================
// CACHE CLEANUP
// ==========================================

// Clean up old caches not matching current user
export function cleanOldCaches() {
    const currentUser = getGitHubUserInfo().username;
    const cacheVersion = 'v2'; // Should match CACHE_VERSION in GameLoader.js
    const currentCacheKey = `game-data-cache-${cacheVersion}-${currentUser}`;
    const currentTimestampKey = `game-data-last-updated-${cacheVersion}-${currentUser}`;
    
    let cleaned = 0;
    const keysToRemove = [];
    
    // Collect keys to remove (can't modify localStorage during iteration)
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        
        // Remove old cache data keys
        if (key && key.startsWith('game-data-cache-') && key !== currentCacheKey) {
            keysToRemove.push(key);
        }
        // Remove old timestamp keys
        if (key && key.startsWith('game-data-last-updated-') && key !== currentTimestampKey) {
            keysToRemove.push(key);
        }
    }
    
    // Remove collected keys
    keysToRemove.forEach(key => {
        localStorage.removeItem(key);
        cleaned++;
    });
    
    if (cleaned > 0) {
        console.log(`✓ Cleaned ${cleaned} old cache entries from other users`);
    }
}