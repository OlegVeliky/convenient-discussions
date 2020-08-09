const fs = require('fs');
const path = require('path');

const argv = require('yargs').argv;

// node buildConfigs --dev
// npm run <command running this script> --dev
const devSuffix = (argv.dev || process.env.npm_config_dev) ? '-dev' : '';

const configs = [];
fs.readdirSync('./config/').forEach((file) => {
  if (path.extname(file) === '.js') {
    const [fullName, name] = path.basename(file).match(/^(\w+-\w+)\.js/) || [];
    configs.push({ name, fullName });
  }
});

configs.forEach((config) => {
  const content = fs.readFileSync(`./config/${config.fullName}`)
    .toString()
    .trim()
    .replace(/[^]*?export default /, '');
  const data = `/**
 * This file was assembled automatically from the configuration at
 * https://github.com/jwbth/convenient-discussions/tree/master/config/${config.fullName} by running
 * "node buildConfigs". The configuration might get outdated as the script evolves, so it's best
 * to keep it up to date by checking for the documentation updates from time to time. See the
 * documentation at
 * https://commons.wikimedia.org/wiki/Special:MyLanguage/User:Jack_who_built_the_house/Convenient_Discussions#Configuring_for_a_wiki.
 */

(function () {

const cdLoaded = Boolean(window.convenientDiscussions && window.convenientDiscussions.running);
window.convenientDiscussions = window.convenientDiscussions || {};

convenientDiscussions.config = ${content}

// Author: [[User:Sophivorus]]
// Licences: GFDL, CC BY-SA 3.0, GPL v2
function decodeBase64(s) {
  return decodeURIComponent(
    window.atob(s)
      .split('')
      .map((character) => (
        '%' +
        ('00' + character.charCodeAt(0).toString(16)).slice(-2)
      ))
      .join('')
  );
}

function getStrings() {
  const lang = mw.config.get('wgUserLanguage');
  return new Promise((resolve) => {
    if (lang === 'en') {
      // English strings are already in the script.
      resolve();
    } else {
      $.get(\`https://gerrit.wikimedia.org/r/plugins/gitiles/mediawiki/gadgets/ConvenientDiscussions/+/master/i18n/$\{lang}.json?format=text\`)
        .then(
          (data) => {
            convenientDiscussions.strings = JSON.parse(decodeBase64(data));
            resolve();
          },
          () => {
            // We assume it's OK to fall back to English if the translation is unavailable for any
            // reason. After all, something wrong could be with Gerrit.
            resolve();
          }
        );
    }
  });
}

if (!cdLoaded) {
  convenientDiscussions.getStringsPromise = getStrings();
  mw.loader.getScript('https://commons.wikimedia.org/w/index.php?title=User:Jack_who_built_the_house/convenientDiscussions${devSuffix}.js&action=raw&ctype=text/javascript')
    .catch((e) => {
      console.warn('Couldn\\'t load Convenient Discussions.', e);
    });
}

}());
`;
  fs.mkdirSync('dist/config', { recursive: true });
  fs.writeFileSync(`dist/config/${config.name}${devSuffix}.js`, data);
});

console.log('Project configs have been built successfully.');
