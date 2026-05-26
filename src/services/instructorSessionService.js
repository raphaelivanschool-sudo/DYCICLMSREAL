import sessionContextService from './sessionContextService';

const instructorSessionService = {
  async getActiveSession() {
    return sessionContextService.getInstructorContext();
  },
};

export default instructorSessionService;

