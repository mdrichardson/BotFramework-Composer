// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as path from 'path';
import * as util from 'util';

import { WebSiteManagementClient } from '@azure/arm-appservice-profile-2019-03-01-hybrid';
import { ResourceManagementClient } from '@azure/arm-resources';
import {
  Deployment,
  DeploymentsCreateOrUpdateResponse,
  DeploymentsValidateResponse,
  ResourceGroup,
  ResourceGroupsCreateOrUpdateResponse,
} from '@azure/arm-resources/esm/models';
import { GraphRbacManagementClient } from '@azure/graph';
// import * as msRestNodeAuth from '@azure/ms-rest-nodeauth';
import { TokenCredentials } from '@azure/ms-rest-js';
import * as fs from 'fs-extra';
import * as rp from 'request-promise';

import { BotProjectDeployConfig } from './botProjectDeployConfig';
import { BotProjectDeployLoggerType } from './botProjectLoggerType';
import archiver = require('archiver');

const exec = util.promisify(require('child_process').exec);
const { promisify } = require('util');

const luBuild = require('@microsoft/bf-lu/lib/parser/lubuild/builder.js');
const readdir = promisify(fs.readdir);

export class BotProjectDeploy {
  private subId: string;
  private creds: any;
  private graphCreds: any;
  private projPath: string;
  private deploymentSettingsPath: string;
  private deployFilePath: string;
  private zipPath: string;
  private publishFolder: string;
  private settingsPath: string;
  private templatePath: string;
  private dotnetProjectPath: string;
  private generatedFolder: string;
  private remoteBotPath: string;
  private logger: (string) => any;

  private readonly tenantId = '72f988bf-86f1-41af-91ab-2d7cd011db47';

  constructor(config: BotProjectDeployConfig) {
    this.subId = config.subId;
    this.logger = config.logger;
    this.creds = new TokenCredentials(config.accessToken);
    this.graphCreds = new TokenCredentials(config.graphToken);
    this.projPath = config.projPath;

    // set path to .deployment file which points at the BotProject.csproj
    this.deployFilePath = config.deployFilePath ?? path.join(this.projPath, '.deployment');

    // path to the zipped assets
    this.zipPath = config.zipPath ?? path.join(this.projPath, 'code.zip');

    // path to the built, ready to deploy code assets
    this.publishFolder = config.publishFolder ?? path.join(this.projPath, 'bin\\Release\\netcoreapp3.1');

    // path to the source appsettings.deployment.json file
    this.settingsPath = config.settingsPath ?? path.join(this.projPath, 'appsettings.deployment.json');

    // path to the deployed settings file that contains additional luis information
    this.deploymentSettingsPath =
      config.deploymentSettingsPath ?? path.join(this.publishFolder, 'appsettings.deployment.json');

    // path to the ARM template
    // this is currently expected to live in the code project
    this.templatePath =
      config.templatePath ?? path.join(this.projPath, 'DeploymentTemplates', 'template-with-preexisting-rg.json');

    // path to the dotnet project file
    this.dotnetProjectPath = config.dotnetProjectPath ?? path.join(this.projPath, 'BotProject.csproj');

    // path to the built, ready to deploy declarative assets
    this.remoteBotPath = config.remoteBotPath ?? path.join(this.publishFolder, 'ComposerDialogs');

    // path to the ready to deploy generated folder
    this.generatedFolder = config.generatedFolder ?? path.join(this.remoteBotPath, 'generated');
  }

  private pack(scope: any) {
    return {
      value: scope,
    };
  }

  private unpackObject(output: any) {
    const unpacked: any = {};
    for (const key in output) {
      const objValue = output[key];
      if (objValue.value) {
        unpacked[key] = objValue.value;
      }
    }
    return unpacked;
  }

  /**
   * Format the parameters
   */
  private getDeploymentTemplateParam(
    appId: string,
    appPwd: string,
    location: string,
    name: string,
    shouldCreateAuthoringResource: boolean
  ) {
    return {
      appId: this.pack(appId),
      appSecret: this.pack(appPwd),
      appServicePlanLocation: this.pack(location),
      botId: this.pack(name),
      shouldCreateAuthoringResource: this.pack(shouldCreateAuthoringResource),
    };
  }

  private async readTemplateFile(templatePath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      fs.readFile(templatePath, { encoding: 'utf-8' }, (err, data) => {
        if (err) {
          reject(err);
        }
        resolve(data);
      });
    });
  }

  /***********************************************************************************************
   * Azure API accessors
   **********************************************************************************************/

  /**
   * Use the Azure API to create a new resource group
   */
  private async createResourceGroup(
    client: ResourceManagementClient,
    location: string,
    resourceGroupName: string
  ): Promise<ResourceGroupsCreateOrUpdateResponse> {
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: `> Creating resource group ...`,
    });
    const param = {
      location: location,
    } as ResourceGroup;

    return await client.resourceGroups.createOrUpdate(resourceGroupName, param);
  }

  /**
   * Validate the deployment using the Azure API
   */
  private async validateDeployment(
    client: ResourceManagementClient,
    templatePath: string,
    location: string,
    resourceGroupName: string,
    deployName: string,
    templateParam: any
  ): Promise<DeploymentsValidateResponse> {
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: '> Validating Azure deployment ...',
    });
    const templateFile = await this.readTemplateFile(templatePath);
    const deployParam = {
      properties: {
        template: JSON.parse(templateFile),
        parameters: templateParam,
        mode: 'Incremental',
      },
    } as Deployment;
    return await client.deployments.validate(resourceGroupName, deployName, deployParam);
  }

  /**
   * Using an ARM template, provision a bunch of resources
   */
  private async createDeployment(
    client: ResourceManagementClient,
    templatePath: string,
    location: string,
    resourceGroupName: string,
    deployName: string,
    templateParam: any
  ): Promise<DeploymentsCreateOrUpdateResponse> {
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: `> Deploying Azure services (this could take a while)...`,
    });
    const templateFile = await this.readTemplateFile(templatePath);
    const deployParam = {
      properties: {
        template: JSON.parse(templateFile),
        parameters: templateParam,
        mode: 'Incremental',
      },
    } as Deployment;

    return await client.deployments.createOrUpdate(resourceGroupName, deployName, deployParam);
  }

  private async createApp(graphClient: GraphRbacManagementClient, displayName: string, appPassword: string) {
    const createRes = await graphClient.applications.create({
      displayName: displayName,
      passwordCredentials: [
        {
          value: appPassword,
          startDate: new Date(),
          endDate: new Date(new Date().setFullYear(new Date().getFullYear() + 2)),
        },
      ],
      availableToOtherTenants: true,
      replyUrls: ['https://token.botframework.com/.auth/web/redirect'],
    });
    return createRes;
  }

  /**
   * Write updated settings back to the settings file
   */
  private async updateDeploymentJsonFile(
    settingsPath: string,
    client: ResourceManagementClient,
    resourceGroupName: string,
    deployName: string,
    appId: string,
    appPwd: string
  ): Promise<any> {
    const outputs = await client.deployments.get(resourceGroupName, deployName);
    return new Promise((resolve, reject) => {
      if (outputs?.properties?.outputs) {
        const outputResult = outputs.properties.outputs;
        const applicationResult = {
          MicrosoftAppId: appId,
          MicrosoftAppPassword: appPwd,
        };
        const outputObj = this.unpackObject(outputResult);

        const result = {};
        Object.assign(result, outputObj, applicationResult);

        fs.writeFile(settingsPath, JSON.stringify(result, null, 4), err => {
          if (err) {
            reject(err);
          }
          resolve(result);
        });
      } else {
        resolve({});
      }
    });
  }

  private async getFiles(dir: string): Promise<string[]> {
    const dirents = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      dirents.map(dirent => {
        const res = path.resolve(dir, dirent.name);
        return dirent.isDirectory() ? this.getFiles(res) : res;
      })
    );
    return Array.prototype.concat(...files);
  }

  private async botPrepareDeploy(pathToDeploymentFile: string) {
    return new Promise((resolve, reject) => {
      const data = `[config]\nproject = BotProject.csproj`;
      fs.writeFile(pathToDeploymentFile, data, err => {
        if (err) {
          reject(err);
        }
        resolve();
      });
    });
  }

  private async dotnetPublish(publishFolder: string, projFolder: string, botPath?: string) {
    // perform the dotnet publish command
    // this builds the app and prepares it to be deployed
    // results in a built copy in publishFolder/
    await exec(`dotnet publish ${this.dotnetProjectPath} -c release -o ${publishFolder} -v q`);

    // Then, copy the declarative assets into the build folder.
    return new Promise((resolve, reject) => {
      const remoteBotPath = path.join(publishFolder, 'ComposerDialogs');
      const localBotPath = path.join(projFolder, 'ComposerDialogs');

      if (botPath) {
        this.logger({
          status: BotProjectDeployLoggerType.DEPLOY_INFO,
          message: `Publishing dialogs from external bot project: ${botPath}`,
        });
        fs.copy(
          botPath,
          remoteBotPath,
          {
            overwrite: true,
            recursive: true,
          },
          err => {
            reject(err);
          }
        );
      } else {
        fs.copy(
          localBotPath,
          remoteBotPath,
          {
            overwrite: true,
            recursive: true,
          },
          err => {
            reject(err);
          }
        );
      }
      resolve();
    });
  }

  private async zipDirectory(source: string, out: string) {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = fs.createWriteStream(out);

    return new Promise((resolve, reject) => {
      archive
        .directory(source, false)
        .on('error', err => reject(err))
        .pipe(stream);

      stream.on('close', () => resolve());
      archive.finalize();
    });
  }

  private notEmptyLuisModel(file: string) {
    return fs.readFileSync(file).length > 0;
  }

  /**
   * Deploy a bot to a location
   */
  public async deploy(
    name: string,
    environment: string,
    luisAuthoringKey?: string,
    luisAuthoringRegion?: string,
    botPath?: string,
    language?: string
  ) {
    try {
      const webClient = new WebSiteManagementClient(this.creds, this.subId);

      // Check for existing deployment files
      if (!fs.pathExistsSync(this.deployFilePath)) {
        await this.botPrepareDeploy(this.deployFilePath);
      }

      if (await fs.pathExists(this.zipPath)) {
        await fs.remove(this.zipPath);
      }

      // dotnet publish
      await this.dotnetPublish(this.publishFolder, this.projPath, botPath);

      // LUIS build
      const settings = await fs.readJSON(this.settingsPath);
      const luisSettings = settings.luis;

      let luisEndpointKey = '';

      if (!luisAuthoringKey) {
        luisAuthoringKey = luisSettings.authoringKey;
        luisEndpointKey = luisSettings.endpointKey;
      }

      if (!luisAuthoringRegion) {
        luisAuthoringRegion = luisSettings.region;
      }

      if (!language) {
        language = 'en-us';
      }

      // Process LUIS
      // TODO: this should be a method of its own
      if (luisAuthoringKey && luisAuthoringRegion) {
        // publishing luis
        const botFiles = await this.getFiles(this.remoteBotPath);
        const modelFiles = botFiles.filter(name => {
          return name.endsWith('.lu') && this.notEmptyLuisModel(name);
        });

        if (!(await fs.pathExists(this.generatedFolder))) {
          await fs.mkdir(this.generatedFolder);
        }
        const builder = new luBuild.Builder(msg =>
          this.logger({
            status: BotProjectDeployLoggerType.DEPLOY_INFO,
            message: msg,
          })
        );

        const loadResult = await builder.loadContents(
          modelFiles,
          language || '',
          environment || '',
          luisAuthoringRegion || ''
        );

        const buildResult = await builder.build(
          loadResult.luContents,
          loadResult.recognizers,
          luisAuthoringKey,
          luisAuthoringRegion,
          name,
          environment,
          language,
          false,
          loadResult.multiRecognizers,
          loadResult.settings
        );
        await builder.writeDialogAssets(buildResult, true, this.generatedFolder);

        this.logger({
          status: BotProjectDeployLoggerType.DEPLOY_INFO,
          message: `lubuild succeed`,
        });

        const luisConfigFiles = (await this.getFiles(this.remoteBotPath)).filter(filename =>
          filename.includes('luis.settings')
        );
        const luisAppIds: any = {};

        for (const luisConfigFile of luisConfigFiles) {
          const luisSettings = await fs.readJson(luisConfigFile);
          Object.assign(luisAppIds, luisSettings.luis);
        }

        const luisEndpoint = `https://${luisAuthoringRegion}.api.cognitive.microsoft.com`;
        const luisConfig: any = {
          endpoint: luisEndpoint,
          endpointKey: luisEndpointKey,
        };

        Object.assign(luisConfig, luisAppIds);

        // Update deploymentSettings with the luis config
        const settings: any = await fs.readJson(this.deploymentSettingsPath);
        settings.luis = luisConfig;

        await fs.writeJson(this.deploymentSettingsPath, settings, {
          spaces: 4,
        });

        // Assign a LUIS key to the endpoint
        const getAccountUri = `${luisEndpoint}/luis/api/v2.0/azureaccounts`;
        const options = {
          headers: { Authorization: `Bearer ${this.creds.token}`, 'Ocp-Apim-Subscription-Key': luisAuthoringKey },
        } as rp.RequestPromiseOptions;
        const response = await rp.get(getAccountUri, options);
        const jsonRes = JSON.parse(response);
        const account = this.getAccount(jsonRes, `${name}-${environment}-luis`);

        for (const k in luisAppIds) {
          const luisAppId = luisAppIds[k];
          this.logger({
            status: BotProjectDeployLoggerType.DEPLOY_INFO,
            message: `Assigning to luis app id: ${luisAppIds}`,
          });
          const luisAssignEndpoint = `${luisEndpoint}/luis/api/v2.0/apps/${luisAppId}/azureaccounts`;
          const options = {
            body: account,
            json: true,
            headers: { Authorization: `Bearer ${this.creds.token}`, 'Ocp-Apim-Subscription-Key': luisAuthoringKey },
          } as rp.RequestPromiseOptions;
          const response = await rp.post(luisAssignEndpoint, options);
          this.logger({
            status: BotProjectDeployLoggerType.DEPLOY_INFO,
            message: response,
          });
        }
        this.logger({
          status: BotProjectDeployLoggerType.DEPLOY_INFO,
          message: 'Luis Publish Success! ...',
        });
      }

      // Build a zip file of the project
      this.logger({
        status: BotProjectDeployLoggerType.DEPLOY_INFO,
        message: 'Packing up the bot service ...',
      });
      await this.zipDirectory(this.publishFolder, this.zipPath);
      this.logger({
        status: BotProjectDeployLoggerType.DEPLOY_INFO,
        message: 'Packing Service Success!',
      });

      // Deploy the zip file to the web app
      this.logger({
        status: BotProjectDeployLoggerType.DEPLOY_INFO,
        message: 'Publishing to Azure ...',
      });
      await this.deployZip(webClient, this.zipPath, name, environment);
      this.logger({
        status: BotProjectDeployLoggerType.DEPLOY_SUCCESS,
        message: 'Publish To Azure Success!',
      });
    } catch (error) {
      console.log(error);
    }
  }

  private getAccount(accounts: any, filter: string) {
    for (const account of accounts) {
      if (account.AccountName === filter) {
        return account;
      }
    }
  }

  // Upload the zip file to Azure
  private async deployZip(webSiteClient: WebSiteManagementClient, zipPath: string, name: string, env: string) {
    this.logger({
      status: BotProjectDeployLoggerType.DEPLOY_INFO,
      message: 'Retrieve publishing details ...',
    });
    const userName = `${name}-${env}`;
    // this seems unsafe!
    const userPwd = `${name}-${env}-${new Date().getTime().toString()}`;

    const updateRes = await webSiteClient.updatePublishingUser({
      publishingUserName: userName,
      publishingPassword: userPwd,
    });
    this.logger({
      status: BotProjectDeployLoggerType.DEPLOY_INFO,
      message: updateRes,
    });

    const publishEndpoint = `https://${name}-${env}.scm.azurewebsites.net/zipdeploy`;

    const publishCreds = Buffer.from(`${userName}:${userPwd}`).toString('base64');

    const fileContent = await fs.readFile(zipPath);
    const options = {
      body: fileContent,
      encoding: null,
      headers: {
        Authorization: `Basic ${publishCreds}`,
        'Content-Type': 'application/zip',
        'Content-Length': fileContent.length,
      },
    } as rp.RequestPromiseOptions;
    const response = await rp.post(publishEndpoint, options);
    this.logger({
      status: BotProjectDeployLoggerType.DEPLOY_INFO,
      message: response,
    });
  }

  /**
   * Provision a set of Azure resources for use with a bot
   */
  public async create(
    name: string,
    location: string,
    environment: string,
    appPassword: string,
    luisAuthoringKey?: string
  ) {
    // Test for the existence of a deployment settings file.
    // if one does not exists, emit an error message and stop.
    if (!fs.existsSync(this.settingsPath)) {
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_INFO,
        message: `! Could not find an 'appsettings.deployment.json' file in the current directory.`,
      });

      // TODO: throw error
      return;
    }

    const settings = await fs.readJson(this.settingsPath);

    // Validate settings
    let appId = settings.MicrosoftAppId;

    // If the appId is not specified, create one
    if (!appId) {
      // this requires an app password. if one not specified, fail.
      if (!appPassword) {
        this.logger({
          status: BotProjectDeployLoggerType.PROVISION_INFO,
          message: `App password is required`,
        });
        // TODO: throw error
        return;
      }
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_INFO,
        message: '> Creating App Registration ...',
      });

      const graphClient = new GraphRbacManagementClient(this.graphCreds, this.tenantId, {
        baseUri: 'https://graph.windows.net',
      });

      // create the app registration
      const appCreated = await this.createApp(graphClient, name, appPassword);
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_INFO,
        message: appCreated,
      });

      // use the newly created app
      appId = appCreated.appId;
    }

    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: `> Create App Id Success! ID: ${appId}`,
    });

    let shouldCreateAuthoringResource = true;
    if (luisAuthoringKey) {
      shouldCreateAuthoringResource = false;
    }

    const resourceGroupName = `${name}-${environment}`;

    // timestamp will be used as deployment name
    const timeStamp = new Date().getTime().toString();
    const client = new ResourceManagementClient(this.creds, this.subId);

    // Create a resource group to contain the new resources
    const rpres = await this.createResourceGroup(client, location, resourceGroupName);
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: rpres,
    });

    // Caste the parameters into the right format
    const deploymentTemplateParam = this.getDeploymentTemplateParam(
      appId,
      appPassword,
      location,
      name,
      shouldCreateAuthoringResource
    );
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: deploymentTemplateParam,
    });

    // Validate the deployment using the Azure API
    const validation = await this.validateDeployment(
      client,
      this.templatePath,
      location,
      resourceGroupName,
      timeStamp,
      deploymentTemplateParam
    );
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: validation,
    });

    // Handle validation errors
    if (validation.error) {
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR,
        message: `! Template is not valid with provided parameters. Review the log for more information.`,
      });
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR,
        message: `! Error: ${validation.error.message}`,
      });
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR,
        message: `+ To delete this resource group, run 'az group delete -g ${resourceGroupName} --no-wait'`,
      });

      // Todo: throw error
      return false;
    }

    // Create the entire stack of resources inside the new resource group
    // this is controlled by an ARM template identified in this.templatePath
    const deployment = await this.createDeployment(
      client,
      this.templatePath,
      location,
      resourceGroupName,
      timeStamp,
      deploymentTemplateParam
    );
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: deployment,
    });

    // Handle errors
    if (deployment._response.status != 200) {
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR,
        message: `! Template is not valid with provided parameters. Review the log for more information.`,
      });
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR,
        message: `! Error: ${validation.error}`,
      });
      this.logger({
        status: BotProjectDeployLoggerType.PROVISION_ERROR,
        message: `+ To delete this resource group, run 'az group delete -g ${resourceGroupName} --no-wait'`,
      });

      // TODO: throw a real error
      return false;
    }

    // Validate that everything was successfully created.
    // Then, update the settings file with information about the new resources
    const updateResult = await this.updateDeploymentJsonFile(
      this.settingsPath,
      client,
      resourceGroupName,
      timeStamp,
      appId,
      appPassword
    );
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_INFO,
      message: updateResult,
    });

    // Handle errors
    if (!updateResult) {
      const operations = await client.deploymentOperations.list(resourceGroupName, timeStamp);
      if (operations) {
        const failedOperations = operations.filter(value => value?.properties?.statusMessage.error !== null);
        if (failedOperations) {
          failedOperations.forEach(operation => {
            switch (operation?.properties?.statusMessage.error.code) {
              case 'MissingRegistrationForLocation':
                this.logger({
                  status: BotProjectDeployLoggerType.PROVISION_ERROR,
                  message: `! Deployment failed for resource of type ${operation?.properties?.targetResource?.resourceType}. This resource is not avaliable in the location provided.`,
                });
                break;
              default:
                this.logger({
                  status: BotProjectDeployLoggerType.PROVISION_ERROR,
                  message: `! Deployment failed for resource of type ${operation?.properties?.targetResource?.resourceType}.`,
                });
                this.logger({
                  status: BotProjectDeployLoggerType.PROVISION_ERROR,
                  message: `! Code: ${operation?.properties?.statusMessage.error.code}.`,
                });
                this.logger({
                  status: BotProjectDeployLoggerType.PROVISION_ERROR,
                  message: `! Message: ${operation?.properties?.statusMessage.error.message}.`,
                });
                break;
            }
          });
        }
      } else {
        this.logger({
          status: BotProjectDeployLoggerType.PROVISION_ERROR,
          message: `! Deployment failed. Please refer to the log file for more information.`,
        });
      }
    }
    this.logger({
      status: BotProjectDeployLoggerType.PROVISION_SUCCESS,
      message: `+ To delete this resource group, run 'az group delete -g ${resourceGroupName} --no-wait'`,
    });
    return true;
  }

  /**
   * createAndDeploy
   * provision the Azure resources AND deploy a bot to those resources
   */
  public async createAndDeploy(
    name: string,
    location: string,
    environment: string,
    appPassword: string,
    luisAuthoringKey?: string,
    luisAuthoringRegion?: string
  ) {
    try {
      await this.create(name, location, environment, appPassword, luisAuthoringKey);
      await this.deploy(name, environment, luisAuthoringKey, luisAuthoringRegion);
    } catch (er) {
      console.log(er);
      throw er;
    }
  }
}
