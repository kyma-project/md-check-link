#!/usr/bin/env node

const fs = require('fs');
const markdownLinkExtractor = require('markdown-link-extractor');
const path = require('path');
const Isemail = require('isemail');
const pkg = require('./package.json');
const { Command, Option } = require('commander');
const program = new Command();

async function worker(pendingMap, filesMap, opts) {
    let link = pendingMap.keys().next().value
    while (link != null) {
        pendingMap.delete(link);
        let result = await checkLink(link, opts);
        for (let filename of filesMap.keys()) {
            let file = filesMap.get(filename);
            for (let entry of file.links) {
                if (entry.link === link) {
                    entry.status = result;
                }
            }
        }
        link = pendingMap.keys().next().value
    }
}

function checkMailTo(link, opts) {
    const address = link
        .substr(7)      // strip "mailto:"
        .split('?')[0]; // trim ?subject=blah hfields
    return Isemail.validate(address) ? 'alive' : 'dead'
}

async function checkLink(link, opts, attempts = 0) {
    let retryOn429 = opts.retryOn429 || false;
    let retryCount = opts.retryCount || 2;
    const backoffTimeout = 60000
    const url = link;
    try {
        let res = await fetch(url, { method: 'HEAD', headers: opts.headers, signal: AbortSignal.timeout(opts.timeout) })
        if (res.status === 200) {
            return 'alive'
        } else {
            if (res.status === 429) {
                if (attempts >= retryCount || !retryOn429) {
                    console.log('429 error for %s, giving up', link);
                    return opts.warnOnlyOn429 ? 'warn': 'dead'
                }
                console.log('429 error for %s, retry no %d in %s seconds', link, attempts + 1, backoffTimeout / 1000);
                return await new Promise((resolve, reject) => {
                    setTimeout(function () {
                        resolve(checkLink(link, opts, attempts + 1));
                    }, backoffTimeout);
                })
            }
            else {
                res = await fetch(url, { method: 'GET', headers: opts.headers, signal: AbortSignal.timeout(opts.timeout) })
                await res.text();
                return res.status === 200 ? 'alive' : 'dead'
            }
        }
    } catch (err) {
        return 'error'
    };
}

class LinkChecker {
    constructor(options) {
        this.files = new Map();
        this.options = options || {};
        this.fileQueue = new Set();
        if (!this.options.basePath) {
            this.options.basePath = process.cwd();
        }
    }
    processReplacements(link) {
        if (this.options.replacementPatterns) {
            for (let replacementPattern of this.options.replacementPatterns) {
                let pattern = replacementPattern.pattern instanceof RegExp ? replacementPattern.pattern : new RegExp(replacementPattern.pattern);
                if (pattern.test(link)) {
                    link = link.replace(pattern, replacementPattern.replacement);
                    if (replacementPattern.docsify) {
                        let queryLink = /(.*)(\?id=)(.*)/gm.exec(link);
                        let newLink = queryLink ? queryLink[1] : link;
                        if (newLink.endsWith('/')) {
                            newLink += 'README.md'
                        }
                        let filename = newLink.split('/').pop();
                        if (filename.indexOf('.') < 0) {
                            newLink += '.md'
                        }
                        if (queryLink) {
                            newLink += '#' + queryLink[3]
                        }
                        link = newLink;
                    }
                }
            }
        }
        return link;
    }

    shouldIgnore(link) {
        if (this.options.ignorePatterns) {
            const shouldIgnore = this.options.ignorePatterns.some(function (ignorePattern) {
                return ignorePattern.pattern instanceof RegExp ? ignorePattern.pattern.test(link) : (new RegExp(ignorePattern.pattern)).test(link) ? true : false;
            });
            return shouldIgnore;
        }
        return false;
    }

    processLink(filename, l, anchors) {
        l = this.processReplacements(l);
        if (this.shouldIgnore(l)) {
            return { link: l, status: 'ignored' }
        }
        if (l.startsWith('#')) {
            return { link: l, status: anchors.includes(l) ? 'alive' : 'dead' }
        }
        if (l.startsWith('mailto:')) {
            return { link: l, status: checkMailTo(l, this.options) }
        }
        if (l.startsWith('http')) {
            return { link: l, status: 'pending' }
        }
        let targetFile = ''
        if (l.startsWith('/')) {
            targetFile = path.join(this.options.basePath, l);
        } else {
            targetFile = path.join(path.dirname(filename), l);
        }
        if (l.split('#').length > 1) {
            targetFile = targetFile.split('#')[0]
            let anchor = '#' + l.split('#')[1];
            this.fileQueue.add(targetFile);
            return { link: l, anchor, targetFile, status: 'pending' }
        }
        return { link: l, targetFile, status: fs.existsSync(targetFile) ? 'alive' : 'dead' }
    }

    addMarkdownFile(filename) {
        let absoluteFilename = path.join(this.options.basePath, filename);
        if (this.files.has(absoluteFilename)) {
            return;
        }
        let markdown = fs.readFileSync(absoluteFilename, 'utf8');
        if (!this.options.ignoreDisable) {
            markdown = [
                /(<!--[ \t]+markdown-link-check-disable[ \t]+-->[\S\s]*?<!--[ \t]+markdown-link-check-enable[ \t]+-->)/mg,
                /(<!--[ \t]+markdown-link-check-disable[ \t]+-->[\S\s]*(?!<!--[ \t]+markdown-link-check-enable[ \t]+-->))/mg,
                /(<!--[ \t]+markdown-link-check-disable-next-line[ \t]+-->\r?\n[^\r\n]*)/mg,
                /([^\r\n]*<!--[ \t]+markdown-link-check-disable-line[ \t]+-->[^\r\n]*)/mg
            ].reduce(function (_markdown, disablePattern) {
                return _markdown.replace(new RegExp(disablePattern), '');
            }, markdown);
        }

        let { links, anchors } = markdownLinkExtractor(markdown);
        if (!links) {
            links = [];
        }
        if (!anchors) {
            anchors = [];
        }
        let entries = links.map(l => this.processLink(absoluteFilename, l, anchors));
        this.files.set(absoluteFilename, { links: entries, anchors });
    }

    addFilesFromQueue() {
        for (let tf of this.fileQueue.values()) {
            if (this.files.has(tf)) {
                continue;
            }
            if (fs.existsSync(tf)) {
                if (fs.lstatSync(tf).isDirectory()){
                    continue; 
                }
                let markdown = fs.readFileSync(tf, 'utf8');
                let { anchors } = markdownLinkExtractor(markdown);
                this.files.set(tf, { links: [], anchors });
            } else {
                this.files.set(tf, { links: [], anchors: [] });
            }
        }
    }

    async checkLinks() {
        this.addFilesFromQueue()
        let pendingMap = new Map()
        for (let filename of this.files.keys()) {
            let file = this.files.get(filename);
            for (let entry of file.links) {
                if (entry.status === 'pending' && entry.anchor) {
                    let f = this.files.get(entry.targetFile);
                    if (f) {
                        entry.status = f.anchors.includes(entry.anchor) ? 'alive' : 'dead';
                    } else {
                        entry.status = 'dead'
                    }
                }
                if (entry.status == 'pending') {
                    pendingMap.set(entry.link, entry);
                }
            }
        }
        let workers = []
        for (let i = 0; i < this.options.parallel; i++) {
            workers.push(worker(pendingMap, this.files, this.options));
        }
        await Promise.all(workers);
    }
    async report() {
        let chalk = (await import('chalk')).default;
        const statusLabels = {
            alive: chalk.green('✓'),
            dead: chalk.red('✖'),
            ignored: chalk.yellow('⚠'),
            warn: chalk.yellow('⚠'),
        };
        let count = 0;
        let deadCount = 0;
        let warnCount = 0;
        for (let filename of this.files.keys()) {
            let file = this.files.get(filename);
            let deadLinks = []
            let warnLinks = []
            for (let entry of file.links) {
                count++;
                if (entry.status === 'dead') {
                    deadCount++;
                    deadLinks.push(entry);
                }
                if (entry.status === 'warn') {
                    warnCount++;
                    warnLinks.push(entry);
                }
            }
            if (deadLinks.length > 0 || warnLinks.length > 0) {
                console.log(chalk.red('\nERROR: %s dead links found in %s !'), deadLinks.length+warnLinks.length, path.relative(this.options.basePath, filename));
            } else if (!this.options.quiet) {
                console.log(chalk.green('\nNo dead links found in %s'), path.relative(this.options.basePath, filename));
            }
            if (this.options.quiet) {
                deadLinks.forEach(function (result) {
                    console.log('  [%s] %s', statusLabels[result.status], result.link);
                });
                warnLinks.forEach(function (result) {
                    console.log('  [%s] %s', statusLabels[result.status], result.link);
                });
            } else {
                for (let entry of file.links) {
                    console.log('  [%s] %s', statusLabels[entry.status], entry.link);
                }
            }
        }
        console.log('%s links checked, %s dead links found, %d rate limited links', count, deadCount, warnCount);
        return deadCount;
    }
}

function loadAllMarkdownFiles(rootFolder = '.') {
    const fs = require('fs');
    const path = require('path');
    const files = [];
    fs.readdirSync(rootFolder).forEach(file => {
        const fullPath = path.join(rootFolder, file);
        if (fs.lstatSync(fullPath).isDirectory()) {
            files.push(...loadAllMarkdownFiles(fullPath));
        } else if (fullPath.endsWith('.md')) {
            files.push(fullPath);
        }
    });
    return files;
}


program
    .version(pkg.version)
    .addOption(new Option('-n, --parallel <number>', 'number of parallel requests').default(2))
    .option('-c, --config <file or url>', 'apply a config file (JSON)')
    .option('-q, --quiet', 'displays errors only')
    .arguments('[filesOrFolders...]')
    .action(async function () {
        let chalk = (await import('chalk')).default;

        let files = this.args
        let opts = this.opts();
        if (!files.length) {
            console.error('No files or folders specified!')
            process.exit(1);
        }
        if (this.opts().config) {
            let config = await loadConfig(opts.config);
            opts.ignorePatterns = config.ignorePatterns;
            opts.replacementPatterns = config.replacementPatterns;
            opts.httpHeaders = config.httpHeaders;
            if (config.timeout) {
                let res = /(\d*)([a-zA-Z]*)/gm.exec(config.timeout);
                if (res) {
                    opts.timeout = parseInt(res[1]);
                    if (res[2] === 's') {
                        opts.timeout = opts.timeout * 1000;
                    }
                }
            }
            opts.ignoreDisable = config.ignoreDisable;
            opts.retryOn429 = config.retryOn429;
            opts.warnOnlyOn429 = config.warnOnlyOn429;
            opts.retryCount = config.retryCount;
            opts.parallel = opts.parallel || config.parallel;
            if (typeof opts.parallel === 'string') {
                opts.parallel = parseInt(opts.parallel);
            }
        }
        const linkChecker = new LinkChecker(opts);

        for (const name of files) {
            if (!fs.existsSync(name)) {
                console.error(chalk.red('\nERROR: File or folder not found: ' + name));
                process.exit(1);
            }
            const stats = fs.statSync(name);
            if (stats.isDirectory()) {
                let files = loadAllMarkdownFiles(name)
                for (let file of files) {
                    linkChecker.addMarkdownFile(file);
                }
            } else {
                linkChecker.addMarkdownFile(name);
            }

        }

        // start time
        console.time("Links checked in")

        await linkChecker.checkLinks();
        let deadCount = await linkChecker.report();
        console.timeEnd("Links checked in")
        process.exit(deadCount > 0 ? 1 : 0);

    })

program.parse(process.argv);

async function loadConfig(config) {
    try {
        if (config.startsWith('http')) {
            return fetch(config).then(res => res.json())
        }
        return JSON.parse(fs.readFileSync(config, 'utf8'))
    } catch (error) {
        console.log(error)
        if (error.code === 'ENOENT') {
            console.error(chalk.red('\nERROR: Config file not found.'));
        } else {
            console.error(chalk.red('\nERROR: Config file not valid.'));
        }
        process.exit(1);
    }
}