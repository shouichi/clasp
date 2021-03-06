/**
 * Clasp command method bodies.
 */
import * as del from 'del';
import * as pluralize from 'pluralize';
import { watchTree } from 'watch';
import { discovery, drive, loadAPICredentials, logger, script } from './auth';
import { fetchProject, getProjectFiles, hasProject, pushFiles } from './files';
import {
  DOT,
  DOTFILE,
  ERROR,
  LOG,
  PROJECT_MANIFEST_BASENAME,
  ProjectSettings,
  checkIfOnline,
  getDefaultProjectName,
  getProjectSettings,
  getScriptURL,
  getWebApplicationURL,
  logError,
  manifestExists,
  saveProject,
  spinner,
} from './utils';
const open = require('opn');
const commander = require('commander');
const chalk = require('chalk');
const { prompt } = require('inquirer');
const padEnd = require('string.prototype.padend');

/**
 * Force downloads all Apps Script project files into the local filesystem.
 * @param cmd.version {number} The version number of the project to retrieve.
 *                             If not provided, the project's HEAD version is returned.
 */
export const pull = async (cmd: {
  version: number;
}) => {
  await checkIfOnline();
  const { scriptId, rootDir } = await getProjectSettings();
  if (scriptId) {
    spinner.setSpinnerTitle(LOG.PULLING);
    fetchProject(scriptId, rootDir, cmd.version);
  }
};

/**
 * Uploads all files into the script.google.com filesystem.
 * TODO: Only push when a non-ignored file is changed.
 * TODO: Only push the specific files that changed (rather than all files).
 * @param cmd.watch {boolean} If true, runs `clasp push` when any local file changes. Exit with ^C.
 */
export const push = async (cmd: {
  watch: boolean,
}) => {
  await checkIfOnline();
  await loadAPICredentials();
  if (cmd.watch) {
    console.log(LOG.PUSH_WATCH);
    // @see https://www.npmjs.com/package/watch
    watchTree('.', (f, curr, prev) => {
      if (typeof f === 'string') { // The first watch doesn't give a string for some reason.
        console.log(`\n${LOG.PUSH_WATCH_UPDATED(f)}\n`);
      }
      console.log(LOG.PUSHING);
      pushFiles();
    });
  } else {
    spinner.setSpinnerTitle(LOG.PUSHING).start();
    pushFiles();
  }
};

/**
 * Outputs the help command.
 */
export const help = () => {
  commander.outputHelp();
  process.exit(0);
};

/**
 * Displays a default message when an unknown command is typed.
 * @param command {string} The command that was typed.
 */
export const defaultCmd = (command: string) => {
  logError(null, ERROR.COMMAND_DNE(command));
};

/**
 * Creates a new Apps Script project.
 * @param title {string} The title of the Apps Script project's file
 * @param parentId {string} The Drive ID of the G Suite doc this script is bound to.
 * @param cmd.rootDir {string} Specifies the local directory in which clasp will store your project files.
 *                    If not specified, clasp will default to the current directory.
 */
export const create = async (title: string, parentId: string, cmd: {
  rootDir: string,
}) => {
  await checkIfOnline();
  if (hasProject()) {
    logError(null, ERROR.FOLDER_EXISTS);
  } else {
    await loadAPICredentials();
    if (!title) {
      await prompt([{
        type : 'input',
        name : 'title',
        message : 'Give a script title:',
        default: getDefaultProjectName(),
      }]).then((answers: any) => {
        title = answers.title;
      }).catch((err: any) => {
        console.log(err);
      });
    }
    spinner.setSpinnerTitle(LOG.CREATE_PROJECT_START(title)).start();
    try {
      const { scriptId } = await getProjectSettings(true);
      if (scriptId) {
        logError(null, ERROR.NO_NESTED_PROJECTS);
        process.exit(1);
      }
    } catch (err) { // no scriptId (because project doesn't exist)
      //console.log(err);
    }
    script.projects.create({ title, parentId }, {}).then(res => {
      spinner.stop(true);
      const createdScriptId = res.data.scriptId;
      console.log(LOG.CREATE_PROJECT_FINISH(createdScriptId));
      const rootDir = cmd.rootDir;
      saveProject(createdScriptId, rootDir);
      if (!manifestExists()) {
        fetchProject(createdScriptId, rootDir); // fetches appsscript.json, o.w. `push` breaks
      }
    }).catch((error: any) => {
      spinner.stop(true);
      if (parentId) {
        console.log(error.errors[0].message, ERROR.CREATE_WITH_PARENT);
      }
      logError(error, ERROR.CREATE);
    });
  }
};

/**
 * Fetches an Apps Script project.
 * Prompts the user if no script ID is provided.
 * @param scriptId {string} The Apps Script project ID to fetch.
 * @param versionNumber {string} An optional version to pull the script from.
 */
export const clone = async (scriptId: string, versionNumber?: number) => {
  await checkIfOnline();
  if (hasProject()) {
    logError(null, ERROR.FOLDER_EXISTS);
  } else {
    if (!scriptId) {
      await loadAPICredentials();
      const list = await drive.files.list({
        pageSize: 10,
        fields: 'files(id, name)',
        orderBy: 'modifiedByMeTime desc',
        q: 'mimeType="application/vnd.google-apps.script"',
      });
      const data = list.data;
      if (!data) return logError(list.statusText, 'Unable to use the Drive API.');
      const files = data.files;
      if (files.length) {
        const fileIds = files.map((file: any) => {
          return {
            name: `${padEnd(file.name, 20)} - (${file.id})`,
            value: file.id,
          };
        });
        await prompt([{
          type : 'list',
          name : 'scriptId',
          message : 'Clone which script? ',
          choices : fileIds,
        }]).then((answers: any) => {
          checkIfOnline();
          spinner.setSpinnerTitle(LOG.CLONING);
          saveProject(answers.scriptId);
          fetchProject(answers.scriptId, '', versionNumber);
        }).catch((err: any) => {
          console.log(err);
        });
      } else {
        console.log(LOG.FINDING_SCRIPTS_DNE);
      }
    } else {
      spinner.setSpinnerTitle(LOG.CLONING);
      saveProject(scriptId);
      fetchProject(scriptId, '', versionNumber);
    }
  }
};

/**
 * Logs out the user by deleting credentials.
 */
export const logout = () => {
  del(DOT.RC.ABSOLUTE_PATH, { force: true }); // del doesn't work with a relative path (~)
  del(DOT.RC.ABSOLUTE_LOCAL_PATH, { force: true });
};

/**
 * Prints StackDriver logs from this Apps Script project.
 * @param cmd.json {boolean} If true, the command will output logs as json.
 * @param cmd.open {boolean} If true, the command will open the StackDriver logs website.
 */
export const logs = async (cmd: {
  json: boolean,
  open: boolean,
  setup: boolean,
}) => {
  await checkIfOnline();
  function printLogs(entries: any[]) {
    for (let i = 0; i < 50 && entries ? i < entries.length : i < 0; ++i) {
      const { severity, timestamp, resource, textPayload, protoPayload, jsonPayload } = entries[i];
      let functionName = resource.labels.function_name;
      functionName = functionName ? padEnd(functionName, 15) : ERROR.NO_FUNCTION_NAME;
      let payloadData: any = '';
      if (cmd.json) {
        payloadData = JSON.stringify(entries[i], null, 2);
      } else {
        const data: any = {
          textPayload,
          jsonPayload: jsonPayload ? jsonPayload.fields.message.stringValue : '',
          protoPayload,
        };
        payloadData = data.textPayload || data.jsonPayload || data.protoPayload || ERROR.PAYLOAD_UNKNOWN;
        if (payloadData && payloadData['@type'] === 'type.googleapis.com/google.cloud.audit.AuditLog') {
          payloadData = LOG.STACKDRIVER_SETUP;
          functionName = padEnd(protoPayload.methodName, 15);
        }
        if (payloadData && typeof(payloadData) === 'string') {
          payloadData = padEnd(payloadData, 20);
        }
      }
      const coloredStringMap: any = {
        ERROR: chalk.red(severity),
        INFO: chalk.blue(severity),
        DEBUG: chalk.yellow(severity),
        NOTICE: chalk.magenta(severity),
      };
      let coloredSeverity:string = coloredStringMap[severity] || severity;
      coloredSeverity = padEnd(String(coloredSeverity), 20);
      console.log(`${coloredSeverity} ${timestamp} ${functionName} ${payloadData}`);
    }
  }
  async function setupLogs(projectId?: string): Promise<string> {
    const promise = new Promise<string>((resolve, reject) => {
      getProjectSettings().then((projectSettings) => {
        console.log('Open this link: ', LOG.SCRIPT_LINK(projectSettings.scriptId));
        console.log(`Go to *Resource > Cloud Platform Project...* and copy your projectId
(including "project-id-")\n`);
        prompt([{
          type : 'input',
          name : 'projectId',
          message : 'What is your GCP projectId?',
        }]).then((answers: any) => {
          projectId = answers.projectId;
          const dotfile = DOTFILE.PROJECT();
          if (dotfile) {
            dotfile.read().then((settings: ProjectSettings) => {
              if (!settings.scriptId) logError(ERROR.SCRIPT_ID_DNE);
              dotfile.write({scriptId: settings.scriptId, projectId});
              resolve(projectId);
            }).catch((err: object) => {
              reject(logError(err));
            });
          } else {
            reject(logError(null, ERROR.SETTINGS_DNE));
          }
        }).catch((err: any) => {
          reject(console.log(err));
        });
      });
    });
    promise.catch(err => {
      logError(err);
      spinner.stop(true);
    });
    return promise;
  }
  let { projectId } = await getProjectSettings();
  projectId = cmd.setup ? await setupLogs() : projectId;
  if (!projectId) {
    console.log(LOG.NO_GCLOUD_PROJECT);
    projectId = await setupLogs();
    console.log(LOG.LOGS_SETUP);
  }
  if (cmd.open) {
    const url = 'https://console.cloud.google.com/logs/viewer?project=' +
        `${projectId}&resource=app_script_function`;
    console.log(`Opening logs: ${url}`);
    open(url, {wait: false});
  }
  await loadAPICredentials();
  const logs = await logger.entries.list({
    resourceNames: [
      `projects/${projectId}`,
    ],
    orderBy: 'timestamp desc',
  });
  const data = logs.data;
  if (!data) return logError(logs.statusText, 'Unable to query StackDriver logs');
  printLogs(data.entries);
};

/**
 * Executes an Apps Script function. Requires additional setup.
 * @param functionName {string} The function name within the Apps Script project.
 * @see https://developers.google.com/apps-script/api/how-tos/execute
 */
export const run = async (functionName:string) => {
  await checkIfOnline();
  await loadAPICredentials();
  getProjectSettings().then(({ scriptId }: ProjectSettings) => {
    const params = {
      scriptId,
      function: functionName,
      devMode: false,
    };
    script.scripts.run(params).then(response => {
      console.log(response.data);
    }).catch(e => {
      console.log(e);
    });
  });
};

/**
 * Deploys an Apps Script project.
 * @param version {string} The project version to deploy at.
 * @param description {string} The deployment's description.
 */
export const deploy = async (version: string, description: string) => {
  await checkIfOnline();
  await loadAPICredentials();
  description = description || '';
  const { scriptId } = await getProjectSettings();
  if (!scriptId) return;
    spinner.setSpinnerTitle(LOG.DEPLOYMENT_START(scriptId)).start();
    function createDeployment(versionNumber: string) {
      spinner.setSpinnerTitle(LOG.DEPLOYMENT_CREATE);
      script.projects.deployments.create({
        scriptId,
        resource: {
          versionNumber,
          manifestFileName: PROJECT_MANIFEST_BASENAME,
          description,
        },
      }, {}, (err: any, response: any) => {
        spinner.stop(true);
        if (err) {
          logError(null, ERROR.DEPLOYMENT_COUNT);
        } else if (response) {
          console.log(`- ${response.data.deploymentId} @${versionNumber}.`);
        }
      });
    }

    // If the version is specified, update that deployment
    const versionRequestBody = {
      description,
    };
    if (version) {
      createDeployment(version);
    } else { // if no version, create a new version and deploy that
      script.projects.versions.create({
        scriptId,
        resource: versionRequestBody,
      }, {}, (err: any, versionResponse: any) => {
        spinner.stop(true);
        if (err) {
          logError(null, ERROR.ONE_DEPLOYMENT_CREATE);
        } else {
          const data = versionResponse.data;
          console.log(LOG.VERSION_CREATED(data.versionNumber));
          createDeployment(data.versionNumber);
        }
      });
    }
};

/**
 * Removes a deployment from the Apps Script project.
 * @param deploymentId {string} The deployment's ID
 */
export const undeploy = async (deploymentId: string) => {
  await checkIfOnline();
  await loadAPICredentials();
  getProjectSettings().then(({ scriptId }: ProjectSettings) => {
    if (!scriptId) return;
    spinner.setSpinnerTitle(LOG.UNDEPLOYMENT_START(deploymentId)).start();
    script.projects.deployments.delete({
      scriptId,
      deploymentId,
    }, {}, (err: any, res: any) => {
      spinner.stop(true);
      if (err) {
        logError(null, ERROR.READ_ONLY_DELETE);
      } else {
        console.log(LOG.UNDEPLOYMENT_FINISH(deploymentId));
      }
    });
  });
};

/**
 * Lists a user's Apps Script projects using Google Drive.
 */
export const list = async () => {
  await checkIfOnline();
  await loadAPICredentials();
  spinner.setSpinnerTitle(LOG.FINDING_SCRIPTS).start();
  const res = await drive.files.list({
    pageSize: 50,
    fields: 'nextPageToken, files(id, name)',
    q: 'mimeType="application/vnd.google-apps.script"',
  });
  spinner.stop(true);
  const files = res.data.files;
  if (files.length) {
    files.map((file: any) => {
      console.log(`${padEnd(file.name, 20)} – ${getScriptURL(file.id)}`);
    });
  } else {
    console.log(LOG.FINDING_SCRIPTS_DNE);
  }
};

/**
 * Redeploys an Apps Script deployment.
 * @param deploymentId {string} The deployment ID to redeploy.
 * @param version {string} The version to redeploy at.
 * @param description {string} A description of the redeployment.
 */
export const redeploy = async (deploymentId: string, version: string, description: string) => {
  await checkIfOnline();
  await loadAPICredentials();
  getProjectSettings().then(({ scriptId }: ProjectSettings) => {
    script.projects.deployments.update({
      scriptId,
      deploymentId,
      resource: {
        deploymentConfig: {
          versionNumber: version,
          manifestFileName: PROJECT_MANIFEST_BASENAME,
          description,
        },
      },
    }, {}, (error: any, res: any) => {
      spinner.stop(true);
      if (error) {
        logError(null, error); // TODO prettier error
      } else {
        console.log(LOG.REDEPLOY_END);
      }
    });
  });
};

/**
 * Lists a script's deployments.
 */
export const deployments = async () => {
  await checkIfOnline();
  await loadAPICredentials();
  const { scriptId } = await getProjectSettings();
  if (!scriptId) return;
    spinner.setSpinnerTitle(LOG.DEPLOYMENT_LIST(scriptId)).start();
    script.projects.deployments.list({
      scriptId,
    }, {}, (error: any, deploymentResponse: any) => {
      spinner.stop(true);
      if (error) {
        logError(error);
      } else {
        const deployments = deploymentResponse.data.deployments;
        const numDeployments = deployments.length;
        const deploymentWord = pluralize('Deployment', numDeployments);
        console.log(`${numDeployments} ${deploymentWord}.`);
        deployments.map(({ deploymentId, deploymentConfig }: any) => {
          const versionString = !!deploymentConfig.versionNumber ?
            `@${deploymentConfig.versionNumber}` : '@HEAD';
          const description = deploymentConfig.description ?
            '- ' + deploymentConfig.description : '';
          console.log(`- ${deploymentId} ${versionString} ${description}`);
        });
      }
    });
};

/**
 * Lists versions of an Apps Script project.
 */
export const versions = async () => {
  await checkIfOnline();
  await loadAPICredentials();
  spinner.setSpinnerTitle('Grabbing versions...').start();
  const { scriptId } = await getProjectSettings();
  script.projects.versions.list({
    scriptId,
    pageSize: 500,
  }, {}, (error: any, versionResponse: any) => {
    spinner.stop(true);
    if (error) {
      logError(error);
    } else {
      const data = versionResponse.data;
      if (data && data.versions && data.versions.length) {
        const numVersions = data.versions.length;
        console.log(LOG.VERSION_NUM(numVersions));
        data.versions.reverse().map((version: string) => {
          console.log(LOG.VERSION_DESCRIPTION(version));
        });
      } else {
        logError(null, LOG.DEPLOYMENT_DNE);
      }
    }
  });
};

/**
 * Creates a new version of an Apps Script project.
 */
export const version = async (description: string) => {
  await checkIfOnline();
  await loadAPICredentials();
  spinner.setSpinnerTitle(LOG.VERSION_CREATE).start();
  const { scriptId } = await getProjectSettings();
  script.projects.versions.create({
    scriptId,
    description,
  }, {}, (error: any, versionResponse: any) => {
    spinner.stop(true);
    if (error) {
      logError(error);
    } else {
      console.log(LOG.VERSION_CREATED(versionResponse.data.versionNumber));
    }
  });
};

/**
 * Displays the status of which Apps Script files are ignored from .claspignore
 * @param cmd.json {boolean} Displays the status in json format.
 */
export const status = async (cmd: { json: boolean }) => {
  await checkIfOnline();
  getProjectSettings().then(({ scriptId, rootDir }: ProjectSettings) => {
    if (!scriptId) return;
    getProjectFiles(rootDir, (err, projectFiles) => {
      if(err) return console.log(err);
      else if (projectFiles) {
        const [filesToPush, untrackedFiles] = projectFiles;
        if (cmd.json) {
          console.log(JSON.stringify({ filesToPush, untrackedFiles }));
        } else {
          console.log(LOG.STATUS_PUSH);
          filesToPush.forEach((file) => console.log(`└─ ${file}`));
          console.log(); // Separate Ignored files list.
          console.log(LOG.STATUS_IGNORE);
          untrackedFiles.forEach((file) => console.log(`└─ ${file}`));
        }
      }
    });
  });
};

/**
 * Opens an Apps Script project's script.google.com editor.
 * @param scriptId {string} The Apps Script project to open.
 */
export const openCmd = async (scriptId: any, cmd: { webapp: boolean }) => {
  await checkIfOnline();
  if (!scriptId) {
    const settings = await getProjectSettings();
    scriptId = settings.scriptId;
  }
  if (scriptId.length < 30) {
    logError(null, ERROR.SCRIPT_ID_INCORRECT(scriptId));
  } else {
    if (cmd.webapp) {
      await loadAPICredentials();
      script.projects.deployments.list({
        scriptId,
      }, {}, (error: any, deploymentResponse: any) => {
        if (error) {
          logError(error);
        } else {
          const deployments = deploymentResponse.data.deployments;
          if (!deployments.length) {
            logError(null, ERROR.SCRIPT_ID_INCORRECT(scriptId));
          } else {
            deployments.sort((d1: any, d2: any) => d1.updateTime.localeCompare(d2.updateTime));
            const deployment = deployments[deployments.length - 1];
            console.log(LOG.OPEN_WEBAPP(deployment.deploymentId));
            open(getWebApplicationURL(deployment), {wait: false});
          }
        }
      });
    } else {
      console.log(LOG.OPEN_PROJECT(scriptId));
      open(getScriptURL(scriptId), {wait: false});
    }
  }
};

/**
 * Acts as a router to apis subcommands
 * Calls functions for list, enable, or disable
 * Otherwise returns an error of command not supported
 */
export const apis = async () => {
  const list = async () => {
    await checkIfOnline();
    const {data} = await discovery.apis.list({
      preferred: true,
    });
    for (const api of data.items) {
      console.log(`${padEnd(api.name, 25)} - ${padEnd(api.id, 30)}`);
    }
  };
  const subcommand: string = process.argv[3]; // clasp apis list => "list"
  const command: {[key: string]: Function} = {
    list,
    enable: () => {console.log('In development...');},
    disable: () => {console.log('In development...');},
    undefined: () => {console.log(`Try:
    clasp apis list`);},
  };
  if (command[subcommand]) {
    command[subcommand]();
  } else {
    logError(null, ERROR.COMMAND_DNE('apis ' + subcommand));
  }
};