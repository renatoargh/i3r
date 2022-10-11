# Idle Instance Identification Report (i3r)

This is a tool that helps identifying idle EC2 instances that are generating unnecesary cost.

You can use the results of this report to decide whether you want to manually pause (or terminate) some instances or if you want to keep them running.

This report skips recently created instances as they might be in use by developers. Instances are only accounted in this report after they are running for 3 days.

### Pre-requirements
1. Node.js installed (`node` and `npx` binaries must be available on the `PATH`). To easily install node: https://github.com/nvm-sh/nvm
2. AWS account credentials

### How To Run
1. At the root of the project, run `npm install`
2. Create a .env file at the root of the project with the following contents and replace the values accordingly:

```plaintext
ACCESS_KEY_ID=
SECRET_ACCESS_KEY=
AWS_REGION=
CPU_USAGE_CRITERIA=3
```

- `ACCESS_KEY_ID`: AWS credential information (required)
- `SECRET_ACCESS_KEY`: AWS credential information (required)
- `AWS_REGION`: AWS region where you want to scan your instances (required)
- `CPU_USAGE_CRITERIA`: Percentage criteria used to determine when a CPU is considered idle or in use (optional. default: 3%)

3. Run `npm run start`
4. Profit
